(() => {
"use strict";
const state=document.getElementById("state"),page=document.getElementById("page");
const params=new URLSearchParams(location.search),slug=params.get("slug");
const cfg=window.TALID_CONFIG||{};
if(!slug||!cfg.SUPABASE_URL||!cfg.SUPABASE_ANON_KEY||!window.supabase){state.textContent="رابط صفحة المنتج غير صحيح أو إعداد الاتصال غير مكتمل.";return;}
const client=window.supabase.createClient(cfg.SUPABASE_URL,cfg.SUPABASE_ANON_KEY);
(async()=>{
try{
 const {data,error}=await client.from("product_landing_pages").select("headline,subheadline,body,images,sale_price,currency_code,seo_title,seo_description,status").eq("slug",slug).eq("status","published").maybeSingle();
 if(error)throw error;if(!data){state.textContent="هذه الصفحة غير منشورة أو لم تعد متاحة.";return;}
 document.title=(data.seo_title||data.headline)+" | TALID";
 const set=(id,value)=>document.getElementById(id).textContent=value||"";
 set("headline",data.headline);set("subheadline",data.subheadline);set("body",data.body);
 set("price",data.sale_price==null?"السعر غير متاح":new Intl.NumberFormat("ar-EG",{style:"currency",currency:data.currency_code||"EGP",maximumFractionDigits:2}).format(Number(data.sale_price)));
 const gallery=document.getElementById("gallery");
 (Array.isArray(data.images)?data.images:[]).forEach(src=>{
  try{const url=new URL(src);if(!["https:","http:"].includes(url.protocol))return;const img=document.createElement("img");img.src=url.href;img.alt=data.headline;img.loading="lazy";gallery.appendChild(img);}catch(_){}
 });
 if(!gallery.children.length)gallery.remove();
 document.getElementById("order").classList.add("hidden");
 state.classList.add("hidden");page.classList.remove("hidden");
}catch(error){state.textContent="تعذر تحميل صفحة المنتج: "+error.message;}
})();
})();