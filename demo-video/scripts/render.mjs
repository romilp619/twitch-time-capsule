import {bundle} from '@remotion/bundler';
import {openBrowser,renderMedia,renderStill,selectComposition} from '@remotion/renderer';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const timeline=JSON.parse(await readFile(path.join(root,'src/timeline.json'),'utf8'));
const qa=process.argv.includes('--qa');
const out=path.join(root,'out');await mkdir(out,{recursive:true});
console.log('Bundling Remotion composition...');
const serveUrl=await bundle({entryPoint:path.join(root,'src/index.tsx'),publicDir:path.join(root,'public')});
const browser=await openBrowser('chrome',{logLevel:'error'});
try {
const composition=await selectComposition({serveUrl,id:'TimeCapsuleComplete',puppeteerInstance:browser});
console.log('Composition',composition.width,composition.height,composition.durationInFrames,'frames');
if(qa){
 for(const scene of timeline.scenes){
  await renderStill({serveUrl,composition,frame:scene.from+Math.floor(scene.durationInFrames*.72),output:path.join(out,'qa-'+scene.id+'.jpg'),imageFormat:'jpeg',jpegQuality:90,puppeteerInstance:browser});
  console.log('QA',scene.id,scene.title);
 }
}else{
 let last=-1;
 await renderMedia({serveUrl,composition,codec:'h264',outputLocation:path.join(out,'Time-Capsule-Complete-Demo.mp4'),crf:20,audioBitrate:'192k',imageFormat:'jpeg',jpegQuality:88,concurrency:4,puppeteerInstance:browser,overwrite:true,onProgress:({progress,renderedFrames,encodedFrames})=>{const pct=Math.floor(progress*100);if(pct!==last){last=pct;console.log('Render',pct+'%',renderedFrames,'rendered',encodedFrames,'encoded');}}});
 console.log('Video rendered');
}
} finally {await browser.close({silent:true});}
