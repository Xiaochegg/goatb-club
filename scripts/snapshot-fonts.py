# ============================================================
# 快照 next/font/google 产物 → 仓库本地字体（一次性迁移工具）
# 背景：layout.tsx 用 next/font/google（Press Start 2P/Geist/Geist Mono），
#       每次编译需联网访问 Google Fonts；部署环境连不上 → 字体静默回退
#       系统字体（"像素字体又失效了"的根因）。
# 方案：从当前编译产物（.next/static/chunks/*.css + media/*.woff2）提取
#       全部 @font-face（含 unicode-range 与度量校正 Fallback），woff2
#       复制到 public/fonts/<family>/<subset>.woff2，生成 src/app/fonts.css。
# 之后 layout.tsx 改引 fonts.css，next/font/google 全部移除 → 编译零外网依赖。
# ============================================================
import re, os, shutil, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHUNKS = sorted(glob.glob(os.path.join(ROOT, '.next/static/chunks/*.css')))
MEDIA = os.path.join(ROOT, '.next/static/media')
OUT_DIR = os.path.join(ROOT, 'public/fonts')
CSS_OUT = os.path.join(ROOT, 'src/app/fonts.css')

FAMILIES = ['Press Start 2P', 'Geist', 'Geist Mono']
FALLBACKS = {'Geist': 'Geist Fallback', 'Geist Mono': 'Geist Mono Fallback',
             'Press Start 2P': 'Press Start 2P Fallback'}

# unicode-range 首段 → 子集名
def subset_name(ur: str) -> str:
    if 'U+??' in ur.upper():
        return 'latin'  # Google latin 子集的通配符首段
    first = ur.split(',')[0].strip().upper().replace('U+', '')
    try:
        cp = int(first.split('-')[0], 16)
    except ValueError:
        return 'misc'
    if cp <= 0x00FF: return 'latin'
    if 0x0100 <= cp <= 0x024F: return 'latin-ext'
    if cp in (0x0301,) or 0x0400 <= cp <= 0x045F: return 'cyrillic'
    if 0x0460 <= cp <= 0x052F: return 'cyrillic-ext'
    if 0x1F00 <= cp <= 0x1FFF: return 'greek'
    if 0x1E00 <= cp <= 0x1EFF: return 'vietnamese'
    if 0x0600 <= cp <= 0x06FF: return 'arabic'
    if 0x0590 <= cp <= 0x05FF: return 'hebrew'
    return f'sub-{cp:04x}'

# 1) 收集所有 @font-face
blocks = []
for f in CHUNKS:
    css = open(f, encoding='utf8', errors='ignore').read()
    for b in re.findall(r'@font-face\{[^}]+\}', css):
        fam = re.search(r'font-family:([^;]+)', b).group(1).strip().strip('"\'')
        if fam in FAMILIES or fam in FALLBACKS.values():
            blocks.append((fam, b))

css_parts = ['/*',
             ' * 本地字体快照（scripts/snapshot-fonts.py 生成）——勿手改。',
             ' * 来源：next/font/google 编译产物（含 unicode-range 子集与度量校正 Fallback）。',
             ' * 目的：编译期零 Google Fonts 网络依赖，部署环境不再发生像素字体回退。',
             ' */',
             ':root {',
             "  --font-geist-sans: Geist, 'Geist Fallback';",
             "  --font-geist-mono: 'Geist Mono', 'Geist Mono Fallback';",
             "  --font-mc-pixel: 'Press Start 2P', 'Press Start 2P Fallback';",
             '}', '']

copied = 0
used_names = set()  # (family, dst_name) 去重，避免同子集名互相覆盖
for fam, block in blocks:
    m = re.search(r'url\(([^)]+)\)', block)
    newb = block
    if m:
        src_file = os.path.basename(m.group(1))
        src_path = os.path.join(MEDIA, src_file)
        ur = re.search(r'unicode-range:([^;}]+)', block)
        sub = subset_name(ur.group(1)) if ur else 'latin'
        dir_name = {'Press Start 2P': 'press-start-2p', 'Geist': 'geist', 'Geist Mono': 'geist-mono'}[fam]
        dst_name = f'{sub}-{src_file.split("-s.")[0][-8:]}.woff2' if '-s.' in src_file else f'{sub}.woff2'
        dst_name = f'{sub}.woff2'
        n = 2
        while (fam, dst_name) in used_names:
            dst_name = f'{sub}-{n}.woff2'
            n += 1
        used_names.add((fam, dst_name))
        dst_dir = os.path.join(OUT_DIR, dir_name)
        os.makedirs(dst_dir, exist_ok=True)
        dst_path = os.path.join(dst_dir, dst_name)
        if not os.path.exists(src_path):
            cand = [p for p in glob.glob(os.path.join(MEDIA, '*.woff2')) if os.path.basename(p).startswith(src_file.split('-s.')[0])]
            src_path = cand[0] if cand else src_path
        shutil.copyfile(src_path, dst_path)
        copied += 1
        newb = block.replace(m.group(1), f'/fonts/{dir_name}/{dst_name}')
    css_parts.append(newb)
    css_parts.append('')

os.makedirs(os.path.dirname(CSS_OUT), exist_ok=True)
open(CSS_OUT, 'w', encoding='utf8').write('\n'.join(css_parts))
print(f'OK: {copied} font faces -> {CSS_OUT}')
for d in sorted(os.listdir(OUT_DIR)):
    print(' ', d, '->', sorted(os.listdir(os.path.join(OUT_DIR, d))))
