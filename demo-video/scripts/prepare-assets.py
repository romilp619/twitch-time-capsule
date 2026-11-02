from pathlib import Path
from PIL import Image
import json,subprocess,hashlib
ROOT=Path(__file__).resolve().parents[1]
TEMP=Path('/mnt/c/Users/Romil/AppData/Local/Temp')
scenes=json.loads((ROOT/'storyboard.json').read_text())
manifest=[]
seen=set()
for scene in scenes:
    shot=scene.get('shot')
    if not shot or shot in seen:continue
    seen.add(shot)
    source=ROOT.parent/'.tmp/phase8-demo.png' if shot=='phase8-demo' else TEMP/('codex-clipboard-'+shot+'.png')
    width,height=Image.open(source).size
    filters=[]
    if scene.get('mask')=='console':
        filters.append(f'crop={width}:{height-100}:0:0')
    elif scene.get('mask')=='overlay-panel':
        filters.extend(['drawbox=x=96:y=150:w=1150:h=57:color=0x101512:t=fill',"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='PRIVATE OVERLAY URL HIDDEN':x=115:y=169:fontsize=21:fontcolor=0xdcc17d"])
    elif scene.get('mask')=='obs-url':
        filters.extend(['drawbox=x=984:y=823:w=830:h=49:color=0x101512:t=fill',"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='PASTE YOUR PRIVATE OVERLAY URL':x=1002:y=837:fontsize=20:fontcolor=0xdcc17d"])
    if scene.get('crop'):
        c=scene['crop'];filters.append(f'crop=iw:ih-{c}:0:{c}')
    filters.append("scale='min(2048,iw)':-1")
    out=ROOT/'public/screenshots'/f'{shot}.png'
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(source),'-vf',','.join(filters),'-frames:v','1','-threads','1',str(out)],check=True)
    scene_size=Image.open(out).size
    manifest.append(dict(asset=shot,source=source.name,sourceSha256=hashlib.sha256(source.read_bytes()).hexdigest(),width=scene_size[0],height=scene_size[1],privacy=scene.get('mask') or ('browser address bar removed' if scene.get('crop') else 'no private key visible')))
(ROOT/'asset-manifest.json').write_text(json.dumps(manifest,indent=2))
print('Prepared',len(manifest),'sanitized screenshot assets')
