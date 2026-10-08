import {prisma} from "./prisma";

export type CustomerLeadOrigin={id:string;name:string;source:string;convertedAt:string|null};

/** 仅在调用方已读到授权客户后调用；独立查询仍经过租户/线索范围限定。 */
export async function 客户来源线索(customerId:string):Promise<CustomerLeadOrigin|null>{
 const lead=await prisma.lead.findUnique({where:{customerId},select:{id:true,name:true,source:true,convertedAt:true}});
 return lead?{...lead,convertedAt:lead.convertedAt?.toISOString()??null}:null;
}
