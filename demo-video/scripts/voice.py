import asyncio,json,sys,subprocess,math
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT.parent/'.tools/video-python'))
import edge_tts
VOICE='en-US-GuyNeural'
scenes=json.loads((ROOT/'storyboard.json').read_text())
semaphore=asyncio.Semaphore(3)
async def generate(scene):
    out=ROOT/'public/voice'/f"{scene['id']}.mp3"
    meta=ROOT/'private'/f"{scene['id']}-words.json"
    async with semaphore:
        if not out.exists() or not meta.exists():
            for attempt in range(3):
                try:
                    words=[]
                    communicate=edge_tts.Communicate(scene['narration'],VOICE,rate='+2%',boundary='WordBoundary')
                    with out.open('wb') as audio:
                        async for chunk in communicate.stream():
                            if chunk['type']=='audio':audio.write(chunk['data'])
                            elif chunk['type']=='WordBoundary':words.append(dict(text=chunk['text'],start=chunk['offset']/1e7,end=(chunk['offset']+chunk['duration'])/1e7))
                    meta.write_text(json.dumps(words))
                    break
                except Exception:
                    if attempt==2:raise
                    await asyncio.sleep(2+attempt*2)
        duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',str(out)],text=True))
        words=json.loads(meta.read_text())
        groups=[];group=[]
        for word in words:
            if group and (len(' '.join(w['text'] for w in group))+len(word['text'])>82 or len(group)>=13):
                groups.append(group);group=[]
            group.append(word)
        if group:groups.append(group)
        scene['audio']='voice/'+out.name;scene['audioDuration']=duration
        scene['durationInFrames']=math.ceil((duration+1.1)*24)
        scene['captions']=[dict(start=g[0]['start'],end=g[-1]['end']+.16,words=g,text=' '.join(w['text'] for w in g)) for g in groups]
        print(scene['id'],round(duration,1),'seconds',flush=True)
async def main():
    await asyncio.gather(*(generate(scene) for scene in scenes))
    cursor=0
    for scene in scenes:scene['from']=cursor;cursor+=scene['durationInFrames']
    (ROOT/'src/timeline.json').write_text(json.dumps(dict(fps=24,durationInFrames=cursor,voice=VOICE,scenes=scenes),indent=2,ensure_ascii=False))
    print('TOTAL',cursor/24,'seconds',flush=True)
asyncio.run(main())
