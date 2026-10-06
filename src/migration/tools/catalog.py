import struct
from mdfparse import records, PAGE

XTYPE={48:'tinyint',52:'smallint',56:'int',127:'bigint',59:'real',62:'float',
 60:'money',122:'smallmoney',106:'decimal',108:'numeric',104:'bit',
 61:'datetime',58:'smalldatetime',40:'date',41:'time',42:'datetime2',43:'datetimeoffset',
 167:'varchar',175:'char',231:'nvarchar',239:'nchar',165:'varbinary',173:'binary',
 36:'uniqueidentifier',34:'image',35:'text',99:'ntext',241:'xml',98:'sql_variant'}
FIXED_LEN_TYPES={'tinyint':1,'smallint':2,'int':4,'bigint':8,'real':4,'float':8,
 'money':8,'smallmoney':4,'datetime':8,'smalldatetime':4,'date':3,'uniqueidentifier':16}
VAR_TYPES={'varchar','nvarchar','varbinary','image','text','ntext','xml'}

def load_data(path):
    return open(path,'rb').read()

def build_catalog(data):
    n=len(data)//PAGE
    # objects (sysschobjs=34)
    objs={}
    for i in range(n):
        o=i*PAGE
        if data[o+1]==1 and struct.unpack_from("<i",data,o+24)[0]==34:
            for r in records(data[o:o+PAGE]):
                f=r['fixed']
                if len(f)<15 or not r['var']: continue
                idv=struct.unpack_from("<i",f,0)[0]
                typ=f[13:15].decode('latin1','replace')
                name=r['var'][0].decode('utf-16-le','replace')
                objs[idv]=(typ,name)
    # columns (syscolpars=41)
    cols={}  # objid -> list of dict
    for i in range(n):
        o=i*PAGE
        if data[o+1]==1 and struct.unpack_from("<i",data,o+24)[0]==41:
            for r in records(data[o:o+PAGE]):
                f=r['fixed']
                if len(f)<27 or not r['var']: continue
                idv=struct.unpack_from("<i",f,0)[0]
                number=struct.unpack_from("<h",f,4)[0]
                colid=struct.unpack_from("<i",f,6)[0]
                xtype=f[10]
                length=struct.unpack_from("<H",f,15)[0]
                prec=f[17]; scale=f[18]
                name=r['var'][0].decode('utf-16-le','replace')
                if number!=0: continue  # skip internal/hidden (e.g., for TVFs)
                cols.setdefault(idv,[]).append(dict(colid=colid,name=name,xtype=xtype,
                    typ=XTYPE.get(xtype,f'x{xtype}'),length=length,prec=prec,scale=scale))
    for k in cols: cols[k].sort(key=lambda c:c['colid'])
    return objs,cols

def row_counts(data):
    from collections import Counter
    n=len(data)//PAGE
    c=Counter()
    for i in range(n):
        o=i*PAGE
        if data[o+1]==1:
            oid=struct.unpack_from("<i",data,o+24)[0]
            idxid=struct.unpack_from("<H",data,o+6)[0]
            if idxid in (0,1):  # heap or clustered leaf
                c[oid]+=struct.unpack_from("<H",data,o+22)[0]
    return c

if __name__=="__main__":
    import sys
    data=load_data("old_app/App Migration/Data/Binayak_DB.mdf")
    objs,cols=build_catalog(data)
    rc=row_counts(data)
    # show row counts for user tables
    usr={i:nm for i,(t,nm) in objs.items() if t=='U '}
    rows=sorted([(rc.get(i,0),nm,i) for i,nm in usr.items()],reverse=True)
    print("=== USER TABLES WITH ROW COUNTS (approx, clustered/heap leaf) ===")
    for cnt,nm,i in rows:
        if cnt>0:
            print(f"  {cnt:>8}  {nm}")
    print("\n=== tables with 0 rows detected:",sum(1 for c,_,_ in rows if c==0),"of",len(rows))
