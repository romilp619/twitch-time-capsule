from pathlib import Path
from http.server import SimpleHTTPRequestHandler,ThreadingHTTPServer
import re
ROOT=Path(__file__).resolve().parents[1]/'out'
class VideoHandler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs):super().__init__(*args,directory=str(ROOT),**kwargs)
    def send_head(self):
        path=Path(self.translate_path(self.path)).resolve()
        if not path.is_relative_to(ROOT.resolve()):self.send_error(403);return None
        if path.is_dir():return super().send_head()
        if not path.is_file():self.send_error(404);return None
        file=path.open('rb');size=path.stat().st_size
        header=self.headers.get('Range')
        self.remaining=size
        if header:
            match=re.fullmatch(r'bytes=(\d*)-(\d*)',header)
            if not match:file.close();self.send_error(416);return None
            start=int(match[1]) if match[1] else max(0,size-int(match[2] or size))
            end=min(size-1,int(match[2])) if match[1] and match[2] else size-1
            if start>=size or end<start:file.close();self.send_error(416);return None
            self.send_response(206);self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
            file.seek(start);self.remaining=end-start+1
        else:self.send_response(200)
        self.send_header('Content-Type',self.guess_type(str(path)))
        self.send_header('Content-Length',str(self.remaining));self.send_header('Accept-Ranges','bytes');self.end_headers()
        return file
    def copyfile(self,source,outputfile):
        remaining=getattr(self,'remaining',None)
        if remaining is None:return super().copyfile(source,outputfile)
        try:
            while remaining:
                data=source.read(min(256*1024,remaining))
                if not data:break
                outputfile.write(data);remaining-=len(data)
        except (BrokenPipeError,ConnectionResetError):pass
    def log_message(self,*args):pass
print('Video player: http://localhost:8765/player.html',flush=True)
ThreadingHTTPServer(('127.0.0.1',8765),VideoHandler).serve_forever()
