export const getStoreId = (req)=>{

const storeId = Number(req.query.storeId);


if(!storeId){
 throw new Error("Store ID required");
}


return storeId;

};