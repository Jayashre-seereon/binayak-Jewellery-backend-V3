import struct, datetime
from catalog import load_data, build_catalog, VAR_TYPES
from mdfparse import records, PAGE

class MDF:
    def __init__(self, path):
        self.data=open(path,'rb').read()
        self.n=len(self.data)//PAGE
        self.objs,self.cols=build_catalog(self.data)
        self.name2id={nm:i for i,(t,nm) in self.objs.items() if t=='U '}
        self._build_alloc()
    def _sys_records(self,oid):
        out=[]
        for i in range(self.n):
            o=i*PAGE
            if self.data[o+1]==1 and struct.unpack_from("<i",self.data,o+24)[0]==oid:
                out+=records(self.data[o:o+PAGE])
        return out
    def _pp(self,b):
        return struct.unpack_from("<I",b,0)[0], struct.unpack_from("<H",b,4)[0]  # pageId,fileId
    def _build_alloc(self):
        rowset2obj={}
        for r in self._sys_records(5):
            f=r['fixed']
            if len(f)<17: continue
            rowset2obj[struct.unpack_from("<q",f,0)[0]]=(struct.unpack_from("<i",f,9)[0],struct.unpack_from("<i",f,13)[0])
        self.obj_pgfirst={}  # (objid,idxid)-> pageId  (first data page)
        self.obj_iam={}      # (objid,idxid)-> iam pageId
        for r in self._sys_records(7):
            f=r['fixed']
            if len(f)<41: continue
            typ=f[8]; ownerid=struct.unpack_from("<q",f,9)[0]
            if typ!=1: continue  # only in-row data
            obj=rowset2obj.get(ownerid)
            if not obj: continue
            self.obj_pgfirst[obj]=self._pp(f[23:29])[0]
            self.obj_iam[obj]=self._pp(f[35:41])[0]
    def _nextpage(self,pid):
        o=pid*PAGE
        pageId=struct.unpack_from("<I",self.data,o+16)[0]; fileId=struct.unpack_from("<H",self.data,o+18)[0]
        return pageId if fileId!=0 or pageId!=0 else 0
    def _iam_pages(self,iam_pid):
        o=iam_pid*PAGE; pages=set()
        for k in range(8):  # single-page slots @142
            pid=struct.unpack_from("<I",self.data,o+142+6*k)[0]; fid=struct.unpack_from("<H",self.data,o+142+6*k+4)[0]
            if fid==1 and 0<pid<self.n: pages.add(pid)
        bm=self.data[o+194:o+PAGE]  # extent bitmap @194, startpage 0, LSB-first
        for bi in range(min(len(bm)*8,6000)):
            if bm[bi//8]>>(bi%8)&1:
                for p in range(bi*8,bi*8+8):
                    if 0<p<self.n and self.data[p*PAGE+1]==1: pages.add(p)
        return sorted(pages)
    def _leaf_pages(self,objid,idxid=1):
        # heap?
        if (objid,0) in self.obj_pgfirst and (objid,1) not in self.obj_pgfirst:
            iam=self.obj_iam.get((objid,0))
            if iam and 0<iam<self.n: return self._iam_pages(iam)
        # walk clustered leaf chain from pgfirst; fallback: scan by offset24 of pgfirst
        start=self.obj_pgfirst.get((objid,idxid))
        pages=[]
        if start and 0<start<self.n:
            # rewind to head using prevPage
            seen=set(); pid=start
            # find head: follow prev
            while True:
                o=pid*PAGE
                prevPid=struct.unpack_from("<I",self.data,o+8)[0]; prevFid=struct.unpack_from("<H",self.data,o+10)[0]
                if prevFid==0 and prevPid==0: break
                if prevPid in seen or not(0<prevPid<self.n): break
                seen.add(prevPid); pid=prevPid
            head=pid; seen=set()
            while pid and 0<pid<self.n and pid not in seen:
                seen.add(pid)
                if self.data[pid*PAGE+1]==1: pages.append(pid)
                nx=self._nextpage(pid)
                pid=nx
        return pages
    def columns(self,name):
        oid=self.name2id[name]
        return self.cols[oid]
    def read_table(self,name,idxid=1):
        oid=self.name2id[name]
        colsdef=self.cols[oid]
        pages=self._leaf_pages(oid,idxid)
        rows=[]
        for pid in pages:
            for r in records(self.data[pid*PAGE:(pid+1)*PAGE]):
                row=self._decode(r,colsdef)
                if row is not None: rows.append(row)
        return colsdef, rows
    def _decode(self,r,colsdef):
        fixed=r['fixed']; var=r['var']; ncol=r['ncol']; nb=r['nullbm']
        # null bitmap bit per column (colid order 1..ncol)
        def isnull(idx0):
            byte=idx0//8; bit=idx0%8
            if byte>=len(nb): return False
            return bool(nb[byte]>>bit & 1)
        out={}
        fpos=0; vpos=0
        # bit packing state
        bit_byte=None; bit_pos=0
        for ci,c in enumerate(colsdef):
            nm=c['name']; typ=c['typ']; ln=c['length']
            if typ in VAR_TYPES:
                if isnull(ci) or vpos>=len(var):
                    out[nm]=None
                else:
                    raw=var[vpos]; vpos+=1
                    out[nm]=self._decv(raw,typ)
                # reset bit packing when hitting var
                bit_byte=None; bit_pos=0
            else:
                if typ=='bit':
                    if bit_byte is None or bit_pos==8:
                        bit_byte=fixed[fpos] if fpos<len(fixed) else 0; fpos+=1; bit_pos=0
                    val=(bit_byte>>bit_pos)&1; bit_pos+=1
                    out[nm]=None if isnull(ci) else val
                    continue
                # non-bit fixed
                bit_byte=None; bit_pos=0
                raw=fixed[fpos:fpos+ln]; fpos+=ln
                out[nm]=None if isnull(ci) else self._decf(raw,typ,c)
        return out
    def _decf(self,raw,typ,c):
        if len(raw)==0: return None
        if typ in('int',): return struct.unpack_from("<i",raw,0)[0] if len(raw)>=4 else int.from_bytes(raw,'little',signed=True)
        if typ=='smallint': return struct.unpack_from("<h",raw,0)[0]
        if typ=='tinyint': return raw[0]
        if typ=='bigint': return struct.unpack_from("<q",raw,0)[0]
        if typ=='real': return struct.unpack_from("<f",raw,0)[0]
        if typ=='float': return struct.unpack_from("<d",raw,0)[0]
        if typ=='money': return struct.unpack_from("<q",raw,0)[0]/10000.0
        if typ=='smallmoney': return struct.unpack_from("<i",raw,0)[0]/10000.0
        if typ in('decimal','numeric'):
            sign=raw[0]; mant=int.from_bytes(raw[1:],'little')
            v=mant/(10**c['scale'])
            return v if sign else -v
        if typ=='datetime':
            # On-disk DATETIME = 4-byte time (1/300 s ticks) THEN 4-byte days since 1900-01-01.
            ticks=struct.unpack_from("<I",raw,0)[0]; days=struct.unpack_from("<i",raw,4)[0]
            try: return (datetime.datetime(1900,1,1)+datetime.timedelta(days=days,seconds=ticks/300.0)).isoformat(sep=' ')
            except: return None
        if typ=='smalldatetime':
            days=struct.unpack_from("<H",raw,0)[0]; mins=struct.unpack_from("<H",raw,2)[0]
            try: return (datetime.datetime(1900,1,1)+datetime.timedelta(days=days,minutes=mins)).isoformat(sep=' ')
            except: return None
        if typ=='char': return raw.decode('latin1','replace').rstrip()
        if typ=='nchar': return raw.decode('utf-16-le','replace').rstrip()
        if typ=='uniqueidentifier': return raw.hex()
        return raw.hex()
    def _decv(self,raw,typ):
        if typ=='nvarchar': return raw.decode('utf-16-le','replace')
        if typ=='varchar': return raw.decode('latin1','replace')
        if typ in('text','ntext'): 
            return None  # LOB pointer, skip for now
        return raw.hex()

if __name__=="__main__":
    import sys
    m=MDF("old_app/App Migration/Data/Binayak_DB.mdf")
    for t in ['JSP_MTL_MST','JSP_MTL_PURT_MST','JSP_CTG_MST','JSP_MTL_GRD_MST']:
        cd,rows=m.read_table(t)
        print(f"\n===== {t} =====  cols={[c['name'] for c in cd]}")
        print("rows:",len(rows))
        for row in rows[:8]:
            print("  ",row)
