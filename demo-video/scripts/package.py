from pathlib import Path
import json,subprocess,math,shutil
ROOT=Path(__file__).resolve().parents[1]
timeline=json.loads((ROOT/'src/timeline.json').read_text())
scenes=timeline['scenes'];fps=timeline['fps']
shutil.copyfile(ROOT/'scripts/player.html',ROOT/'out/player.html')
chapter_names={0:'Overview',1:'Phase 1 - Foundation and local server',2:'Phase 2 - Twitch app and authentication',3:'Phase 3 - EventSub and chat commands',4:'Phase 4 - Capsules, sealing and public page',5:'Phase 5 - Triggers and going live in OBS',6:'Phase 6 - Moderation, ceremony and OBS overlay',7:'Phase 7 - Prophets, VIP and public recognition',8:'Phase 8 - Account-free demo and CLI testing'}
def stamp(t,ms=False):
    t=max(0,t);h=int(t//3600);m=int(t//60)%60;s=int(t)%60
    return f'{h:02}:{m:02}:{s:02}'+(f",{int((t%1)*1000):03}" if ms else '')
subtitles=[];transcript=['# Time Capsule: complete narrated walkthrough','',f"1080p, 24 fps, {stamp(timeline['durationInFrames']/fps)}. English synthetic narration ({timeline['voice']}).",'','This companion video covers the eight completed phases. Phase 9 is not implemented by this video project.','']
chapters=[];last=None
coverage=['# Screenshot and step coverage','','All 37 screenshots supplied in this chat are included. Browser address bars and private overlay URL fields were removed or covered in derived video assets. Originals are not copied into this project.','','| Video step | Phase | Topic | Screenshot source |','|---|---|---|---|']
for scene in scenes:
    start=scene['from']/fps
    if scene['phase']!=last:
        chapters.append((start,chapter_names[scene['phase']]))
        transcript.extend(['## '+chapter_names[scene['phase']],''])
        last=scene['phase']
    transcript.extend([f"### {stamp(start)} - {scene['title']}",'',scene['narration'],''])
    for caption in scene['captions']:
        text=caption['text']
        # Keep captions short enough for video players, with no clipped sentence ends.
        words=text.split();line='';lines=[]
        for word in words:
            if len(line)+len(word)>44:lines.append(line);line=''
            line+=((' ' if line else '')+word)
        if line:lines.append(line)
        subtitles.append(f"{len(subtitles)+1}\n{stamp(start+.5+caption['start'],True)} --> {stamp(start+.5+caption['end'],True)}\n"+'\n'.join(lines)+'\n')
    coverage.append(f"| {scene['id']} | {scene['phase']} | {scene['title']} | {('codex-clipboard-'+scene['shot']+'.png') if scene['shot'] and scene['shot']!='phase8-demo' else ('phase8-demo.png' if scene['shot'] else 'New Remotion technical card')} |")
(ROOT/'out/Time-Capsule-Captions.srt').write_text('\n'.join(subtitles))
(ROOT/'out/Time-Capsule-Transcript.md').write_text('\n'.join(transcript))
(ROOT/'SCREENSHOT-COVERAGE.md').write_text('\n'.join(coverage)+'\n')
chapter_text='\n'.join(stamp(t)+' '+name for t,name in chapters)+'\n'
(ROOT/'out/Time-Capsule-Chapters.txt').write_text(chapter_text)
metadata=[';FFMETADATA1','title=Time Capsule - Complete Demo (Phases 1-8)','artist=Romil','comment=Built with Remotion. Synthetic English narration. Real build screenshots; private keys hidden. Fake VIP in demo mode only.']
for i,(start,name) in enumerate(chapters):
    end=chapters[i+1][0] if i+1<len(chapters) else timeline['durationInFrames']/fps
    metadata.extend(['[CHAPTER]','TIMEBASE=1/1000','START='+str(round(start*1000)),'END='+str(round(end*1000)), 'title='+name])
(ROOT/'private/chapters.ffmeta').write_text('\n'.join(metadata)+'\n')
print('Captions',len(subtitles),'Chapters',len(chapters),'Screenshots',len(set(s['shot'] for s in scenes if s['shot'] and s['shot']!='phase8-demo')))
if '--mux' in __import__('sys').argv:
    output=ROOT/'out/Time-Capsule-Complete-Demo.mp4';raw=ROOT/'private/remotion-render.mp4'
    if not raw.exists(): output.rename(raw)
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','warning','-y','-i',str(raw),'-i',str(ROOT/'private/chapters.ffmeta'),'-i',str(ROOT/'out/Time-Capsule-Captions.srt'),'-map','0:v:0','-map','0:a:0','-map','2:0','-map_metadata','1','-map_chapters','1','-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-af','loudnorm=I=-16:TP=-1.5:LRA=11','-c:s','mov_text','-metadata:s:s:0','language=eng','-disposition:s:0','0','-movflags','+faststart',str(output)],check=True)
    print('Final chaptered, normalized MP4:',output)
