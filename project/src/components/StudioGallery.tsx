import { useId, useState } from "react";
import { artPath, factoryCards, portraitLibrary, thumbnail } from "../../shared/studioCatalog";
import type { CharacterCardData } from "../../shared/characterCard";
import { useLocale } from "../i18n";

export function StudioGallery({ start, copy, close, ready, settings }: {
 start:(card:CharacterCardData)=>void; copy:(card:CharacterCardData)=>void; close:()=>void; ready:boolean; settings:()=>void;
}) {
 const locale=useLocale(), ru=locale==="ru-RU", cards=factoryCards(locale);
 const [index,select]=useState(0), card=cards[index];
 return <section className="studio-gallery" aria-label={ru?"Галерея персонажей":"Character gallery"}>
  <div className="studio-gallery-main"><div className="studio-gallery-brand"><img src="/studio/mark.svg" alt=""/>Local AI Chat</div>
  <h1>{ru?"С кем поговорим?":"Who will you meet?"}</h1>
  <p>{ru?"Выбери собеседника или начни обычный разговор с AI.":"Choose a character or start a conversation with the AI."}</p>
  <div className="studio-card-grid">{cards.map((c,i)=><button type="button" key={c.id} aria-pressed={index===i} onClick={()=>select(i)}>
   <img src={thumbnail(c.posterUrl)} alt=""/><span><strong>{c.name}</strong><small>{c.tags[0]}</small><span>{c.description}</span></span></button>)}</div>
  <button className="studio-quiet" onClick={close}>{ru?"Перейти в обычный чат":"Open regular chat"} →</button></div>
  <div className="studio-feature"><img key={card.id} src={card.posterUrl} alt={card.name}/><div><small>{card.tags[0]}</small><h2>{card.name}</h2><p>{card.firstMessage}</p>
  <button className="studio-cta" onClick={()=>start(card)}>{ru?"Начать диалог":"Start a chat"} ↗</button>
  {!ready && <button onClick={settings}>{ru?"Настроить модель":"Configure model"}</button>}
  <button onClick={()=>copy(card)}>{ru?"Создать копию":"Create a copy"}</button><small>{ru?"Оригинал доступен только для чтения. Копию можно редактировать.":"The original is read-only. Make a copy to edit it."}</small></div></div>
 </section>;
}
export function PortraitPicker({value,change}:{value?:string;change:(url:string)=>void}) {
 const ru=useLocale()==="ru-RU", id=useId(), [error,setError]=useState("");
 async function upload(file?:File){
  if(!file)return;
  try{
   if(!["image/jpeg","image/webp","image/png"].includes(file.type)||file.size>12*1024*1024)throw Error();
   const bitmap=await createImageBitmap(file);
   const scale=Math.min(1,600/bitmap.width,900/bitmap.height), canvas=document.createElement("canvas");
   canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
   const ctx=canvas.getContext("2d");if(!ctx){bitmap.close();throw Error();}ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);bitmap.close();
   let quality=.86, url=canvas.toDataURL("image/webp",quality);
   while(url.length>170000&&quality>.25){quality-=.15;url=canvas.toDataURL("image/webp",quality);}
   if(url.length>170000)throw Error();
   change(url);setError("");
  }catch{setError(ru?"Выберите изображение JPG, PNG или WebP до 12 МБ.":"Choose a JPG, PNG or WebP image up to 12 MB.");}
 }
 return <details className="studio-picker"><summary>{ru?"Библиотека портретов":"Portrait library"}</summary>
 <div>{portraitLibrary.map((key,i)=><button type="button" key={key} aria-pressed={value===artPath(key)} aria-label={(ru?"Портрет ":"Portrait ")+(i+1)} onClick={()=>change(artPath(key))}><img loading="lazy" src={artPath(key,true)} alt=""/></button>)}</div>
 <label htmlFor={id}>{ru?"Загрузить свой портрет":"Upload your portrait"}</label><input id={id} type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>{void upload(e.currentTarget.files?.[0]);e.currentTarget.value="";}}/>{error&&<p role="alert">{error}</p>}</details>;
}
export function StudioAvatar({card, neutral = false}:{card?:{posterUrl?:string;avatar?:string}|null;neutral?:boolean}){
 const url = card ? thumbnail(card.posterUrl) : neutral ? undefined : artPath("muse", true);
 return <span className="studio-avatar" aria-hidden="true">{url ? <img src={url} loading="lazy" alt=""/> : card?.avatar || "◇"}</span>;
}
export function StudioPortrait({card,emptyName}:{card?:{name:string;posterUrl?:string;description?:string;avatar?:string}|null;emptyName?:string}){
 const ru=useLocale()==="ru-RU";const [collapsed,setCollapsed]=useState(false);
 const name=card?.name||emptyName||(ru?"Муза":"Muse");
 const url=card?card.posterUrl:emptyName?undefined:artPath("muse");
 return <section className="studio-portrait" data-collapsed={collapsed}>
 <button type="button" aria-expanded={!collapsed} onClick={()=>setCollapsed(!collapsed)}>{collapsed?(ru?"Показать портрет":"Show portrait"):(ru?"Свернуть портрет":"Collapse portrait")} {collapsed?"＋":"−"}</button>
 {!collapsed&&<figure>{url?<img src={url} alt={name}/>:<span>{card?.avatar||"◇"}</span>}<figcaption><strong>{name}</strong>{card?.description&&<p>{card.description}</p>}</figcaption></figure>}</section>;
}

