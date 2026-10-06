import struct
PAGE=8192
class Page:
    def __init__(self,buf,pid):
        self.buf=buf; self.pid=pid
        h=buf[:96]
        self.ver=h[0]; self.type=h[1]; self.indexId=struct.unpack_from("<H",h,6)[0]
        self.pminlen=struct.unpack_from("<H",h,14)[0]
        self.slotCnt=struct.unpack_from("<H",h,22)[0]
        self.objId=struct.unpack_from("<i",h,24)[0]
    def slots(self):
        out=[]
        for i in range(self.slotCnt):
            off=struct.unpack_from("<H",self.buf,PAGE-2-2*i)[0]
            out.append(off)
        return out

def parse_record(buf):
    # buf = page bytes, returns list of records as dict with fixed bytes + var col byte-slices
    pass

def records(pagebuf):
    p=Page(pagebuf,0)
    recs=[]
    for off in p.slots():
        if off<96 or off>=PAGE: continue
        rec=pagebuf[off:]
        statusA=rec[0]
        fixedLen=struct.unpack_from("<H",rec,2)[0]
        if fixedLen<4 or fixedLen>PAGE: continue
        fixed=rec[4:fixedLen]
        pos=fixedLen
        try:
            ncol=struct.unpack_from("<H",rec,pos)[0]; pos+=2
        except: continue
        nb=(ncol+7)//8
        nullbm=rec[pos:pos+nb]; pos+=nb
        varcols=[]
        if statusA & 0x20:
            nvar=struct.unpack_from("<H",rec,pos)[0]; pos+=2
            offs=[struct.unpack_from("<H",rec,pos+2*i)[0] for i in range(nvar)]
            pos+=2*nvar
            start=pos
            for i in range(nvar):
                end=offs[i]
                # high bit may be complex column flag; mask 0x8000
                endm=end & 0x7fff
                varcols.append(rec[start:endm])
                start=endm
        recs.append(dict(statusA=statusA,fixedLen=fixedLen,fixed=fixed,ncol=ncol,nullbm=nullbm,var=varcols,raw=rec[:pos]))
    return recs

if __name__=="__main__":
    import sys
    data=open("old_app/App Migration/Data/Binayak_DB.mdf",'rb').read()
    n=len(data)//PAGE
    want=int(sys.argv[1]) if len(sys.argv)>1 else 34
    shown=0
    for i in range(n):
        if data[i*PAGE+1]==1 and struct.unpack_from("<i",data,i*PAGE+24)[0]==want:
            for r in records(data[i*PAGE:(i+1)*PAGE]):
                idv=struct.unpack_from("<i",r['fixed'],0)[0] if len(r['fixed'])>=4 else None
                name=r['var'][0].decode('utf-16-le','replace') if r['var'] else ''
                print(f"id={idv} fixedlen={r['fixedLen']} ncol={r['ncol']} nvar={len(r['var'])} name={name!r} fixed_hex={r['fixed'][:24].hex()}")
                shown+=1
                if shown>=25: sys.exit()
