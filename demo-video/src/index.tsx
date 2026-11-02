import React from 'react';
import {AbsoluteFill,Composition,Html5Audio,Img,Sequence,interpolate,registerRoot,staticFile,useCurrentFrame,useVideoConfig} from 'remotion';
import timeline from './timeline.json';
import assets from '../asset-manifest.json';
const GOLD='#dec17c',WHITE='#f1f1e9',MUTED='#a5b1a8';
const chapters=['The complete walkthrough','Foundation','Twitch authentication','EventSub and chat','Capsules and sealing','Opening triggers + OBS','Ceremony and overlay','Prophets and VIP','Account-free demo'];
const focuses:Record<string,number[]>={
 '04':[.02,.30,.60,.64],'05':[.18,.28,.64,.62],'06':[.03,.49,.72,.49],'07':[.78,.10,.22,.65],'08':[.77,.10,.23,.56],
 '09':[.08,.06,.34,.90],'10':[.37,.20,.49,.47],'11':[.79,.13,.21,.62],'12':[.20,.12,.57,.68],
 '13':[.37,.23,.37,.47],'14':[.36,.24,.40,.51],'15':[.36,.24,.41,.44],'16':[.42,.27,.46,.65],
 '17':[.31,.10,.47,.62],'18':[.20,.01,.50,.79],'19':[.39,.16,.43,.57],'20':[.02,.05,.20,.72],
 '21':[.02,.01,.20,.88],'22':[.72,.59,.17,.29],'23':[.18,.10,.44,.69],'24':[.0,.43,.30,.52],
 '25':[.15,.09,.44,.66],'26':[.10,.42,.68,.42],'27':[.0,.67,.23,.33],'28':[.04,.00,.79,.35],
 '29':[.40,.25,.58,.72],'30':[.0,.60,.25,.40],'31':[.14,.03,.75,.62],
 '33':[.15,.11,.24,.73],'34':[.79,.10,.21,.46],'35':[.37,.08,.42,.39],'36':[.67,.10,.19,.35],
 '37':[.79,.13,.21,.38],'38':[.01,.67,.24,.29],'39':[.13,.38,.75,.49],'40':[.13,.29,.74,.55],
 '41':[.16,.48,.66,.39],'42':[.01,.46,.98,.53],'44':[.01,.46,.98,.53]
};
const Caption:React.FC<{scene:any}>=({scene})=>{
 const f=useCurrentFrame();const t=(f-12)/24;
 const cap=scene.captions.find((c:any)=>t>=c.start&&t<c.end);
 if(!cap)return null;
 return <div style={{position:'absolute',left:230,right:230,bottom:46,minHeight:80,display:'flex',alignItems:'center',justifyContent:'center',padding:'10px 30px',background:'rgba(5,10,8,.94)',border:'1px solid #344338',borderRadius:16,textAlign:'center',fontSize:32,lineHeight:1.35,fontWeight:500}}><div>{cap.words.map((w:any,i:number)=><React.Fragment key={i}><span style={{color:t>=w.start&&t<w.end?GOLD:WHITE}}>{w.text}</span>{' '}</React.Fragment>)}</div></div>;
};
const Screenshot:React.FC<{scene:any}>=({scene})=>{
 const f=useCurrentFrame();const asset=assets.find((a:any)=>a.asset===scene.shot)!;
 const W=1356,H=542;const focus=focuses[scene.id]??[0,0,1,1];
 const a=interpolate(f,[scene.durationInFrames*.46,scene.durationInFrames*.68],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
 const startScale=Math.min(W/asset.width,H/asset.height);
 const endScale=Math.min(W/(asset.width*focus[2]),H/(asset.height*focus[3]));
 const scale=startScale+(endScale-startScale)*a;
 const cx=asset.width/2+(asset.width*(focus[0]+focus[2]/2)-asset.width/2)*a;
 const cy=asset.height/2+(asset.height*(focus[1]+focus[3]/2)-asset.height/2)*a;
 return <div style={{position:'absolute',inset:0,borderRadius:18,overflow:'hidden',border:'1px solid #3e4b3e',background:'#101613'}}>
 <div style={{height:36,background:'#202923',borderBottom:'1px solid #3e4b3e',display:'flex',alignItems:'center',gap:9,padding:'0 18px'}}><div style={{width:8,height:8,borderRadius:8,background:'#c9aa65'}}/><div style={{width:8,height:8,borderRadius:8,background:'#7e9783'}}/><span style={{marginLeft:9,fontSize:13,letterSpacing:2,color:MUTED}}>{scene.shot==='phase8-demo'?'PHASE 8 · WORKING DEMO':'YOUR ORIGINAL BUILD SCREENSHOT'}</span><span style={{marginLeft:'auto',fontSize:13,color:GOLD}}>STEP {scene.id} / {timeline.scenes.length}</span></div>
 <div style={{position:'relative',width:W,height:H,overflow:'hidden'}}><Img src={staticFile('screenshots/'+scene.shot+'.png')} style={{position:'absolute',width:asset.width*scale,height:asset.height*scale,left:W/2-cx*scale,top:H/2-cy*scale}}/></div>
 </div>;
};
const Technical:React.FC<{scene:any}>=({scene})=>{
 const f=useCurrentFrame();const reveal=interpolate(f,[8,35],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
 return <div style={{height:'100%',background:'linear-gradient(135deg,#18251d,#101713)',border:'1px solid #4e5b45',borderRadius:22,padding:'38px 48px',opacity:reveal}}>
 <div style={{fontSize:17,letterSpacing:3,color:GOLD,marginBottom:32}}>{scene.kind==='health'?'SERVER HEALTH':scene.kind==='story'?'THE 90-SECOND DEMO':scene.kind==='outro'?'ALL EIGHT PHASES':scene.kind==='workflow'?'THE REVEAL WORKFLOW':'COMMAND WALKTHROUGH'}</div>
 <pre style={{fontFamily:'monospace',fontSize:scene.kind==='cli'?24:scene.kind==='outro'?30:scene.kind==='story'?29:scene.kind==='workflow'?30:32,lineHeight:scene.kind==='story'?1.44:1.7,margin:0,color:scene.kind==='health'?'#c8e3b9':WHITE,whiteSpace:'pre-wrap'}}>{scene.code}</pre>
 {scene.kind==='health'&&<div style={{marginTop:27,fontSize:20,color:GOLD}}>http://localhost:3000/health</div>}
 </div>;
};
const Scene:React.FC<{scene:any}>=({scene})=>{
 const f=useCurrentFrame();const enter=interpolate(f,[0,12],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});const exit=interpolate(f,[scene.durationInFrames-8,scene.durationInFrames],[1,0],{extrapolateLeft:'clamp',extrapolateRight:'clamp'});
 return <AbsoluteFill style={{opacity:Math.min(enter,exit),transform:`translateY(${(1-enter)*14}px)`}}>
 <div style={{position:'absolute',left:56,top:148,right:56,fontFamily:'Georgia,serif',fontWeight:400,fontSize:scene.title.length>52?57:64,lineHeight:1.12,letterSpacing:-1.6,maxWidth:1770}}>{scene.title}</div>
 <div style={{position:'absolute',left:56,top:330,width:386}}>
 <div style={{color:GOLD,fontSize:16,letterSpacing:3,marginBottom:27}}>STEP {scene.id} · {scene.phase===0?'OVERVIEW':'PHASE '+scene.phase}</div>
 {scene.bullets.map((b:string,i:number)=><div key={b} style={{display:'flex',gap:16,marginBottom:27,opacity:interpolate(f,[12+i*4,22+i*4],[0,1],{extrapolateLeft:'clamp',extrapolateRight:'clamp'})}}><div style={{marginTop:11,width:7,height:7,minWidth:7,borderRadius:'50%',background:GOLD}}/><div style={{fontSize:28,lineHeight:1.4,color:i===0?WHITE:MUTED}}>{b}</div></div>)}
 <div style={{marginTop:30,paddingTop:25,borderTop:'1px solid #344036',color:'#74887b',fontSize:15,lineHeight:1.5,letterSpacing:1}}>TIME CAPSULE<br/>CODEX × TWITCHCON HACKATHON</div>
 </div>
 <div style={{position:'absolute',left:506,top:320,width:1358,height:580}}>{scene.shot?<Screenshot scene={scene}/>:<Technical scene={scene}/>}</div>
 <Caption scene={scene}/><Sequence from={12}><Html5Audio src={staticFile(scene.audio)} volume={1}/></Sequence>
 </AbsoluteFill>;
};
const Video:React.FC=()=>{
 const frame=useCurrentFrame();const scene=timeline.scenes.find((s:any)=>frame>=s.from&&frame<s.from+s.durationInFrames)??timeline.scenes[0];
 return <AbsoluteFill style={{background:'radial-gradient(ellipse at 85% 15%,#243326 0%,#111b15 35%,#0b110e 75%)',fontFamily:'Arial,sans-serif',color:WHITE}}>
 <AbsoluteFill style={{backgroundImage:'linear-gradient(#ffffff03 1px,transparent 1px),linear-gradient(90deg,#ffffff03 1px,transparent 1px)',backgroundSize:'100px 100px'}}/>
 <div style={{position:'absolute',left:58,top:45,display:'flex',alignItems:'center',gap:20}}><div style={{width:23,height:43,border:'3px solid '+GOLD,borderRadius:20,transform:'rotate(34deg)',position:'relative'}}><div style={{position:'absolute',top:18,width:20,borderTop:'3px solid '+GOLD}}/></div><div style={{fontSize:24,letterSpacing:5,fontWeight:600}}>TIME CAPSULE</div></div>
 <div style={{position:'absolute',right:57,top:52,color:GOLD,fontSize:18,letterSpacing:3}}>{scene.phase===0?'COMPLETE DEMO':'PHASE '+scene.phase+' / 8'} <span style={{marginLeft:22,color:MUTED,letterSpacing:1}}>{chapters[scene.phase].toUpperCase()}</span></div>
 <div style={{position:'absolute',left:56,right:56,top:109,display:'flex',gap:9}}>{Array.from({length:8},(_,i)=><div key={i} style={{height:3,flex:1,background:i+1<=scene.phase?GOLD:'#2b392f'}}/>)}</div>
 {timeline.scenes.map((s:any)=><Sequence key={s.id} from={s.from} durationInFrames={s.durationInFrames} name={s.id+' '+s.title}><Scene scene={s}/></Sequence>)}
 <div style={{position:'absolute',bottom:0,left:0,width:(frame/timeline.durationInFrames*100)+'%',height:5,background:GOLD}}/>
 <div style={{position:'absolute',bottom:15,left:58,fontSize:13,color:'#7d8d80',letterSpacing:2}}>NARRATED WALKTHROUGH · PHASES 1–8</div>
 <div style={{position:'absolute',bottom:15,right:58,fontSize:13,color:'#7d8d80'}}>Synthetic English narration · Remotion</div>
 </AbsoluteFill>;
};
const Root=()=> <Composition id="TimeCapsuleComplete" component={Video} width={1920} height={1080} fps={24} durationInFrames={timeline.durationInFrames}/>;
registerRoot(Root);
