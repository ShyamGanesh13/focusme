import sys, os, re, brotli, hashlib
exe, outdir = sys.argv[1], sys.argv[2]
data = open(exe,'rb').read()
paths = sorted(set(re.findall(rb'/(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.(?:html|js|css|svg|png|ico|wav|mp3|ogg|json|woff2?|ttf)', data)))
for p in paths:
    for m in re.finditer(re.escape(p), data):
        off = m.end()
        d = brotli.Decompressor(); out=b''; pos=off
        try:
            while pos < len(data) and not d.is_finished() and pos-off < 3_000_000:
                out += d.process(data[pos:pos+1]); pos += 1
        except brotli.error:
            continue
        if d.is_finished() and out:
            rel = p.decode().lstrip('/')
            dest = os.path.join(outdir, rel); os.makedirs(os.path.dirname(dest) or outdir, exist_ok=True)
            open(dest,'wb').write(out)
            print(f"{rel:32} {pos-off:8} -> {len(out):8}  {hashlib.sha256(out).hexdigest()}")
            break
