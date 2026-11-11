import os
from PIL import Image, ImageDraw, ImageFont

OUT = r'C:\\Users\\123\\Downloads\\edge本地扩展\\dsh-translate' + '/icons'
os.makedirs(OUT, exist_ok=True)

def rounded(size, radius_ratio=0.23):
    s = size * 4  # 超采样，边缘更干净
    img = Image.new('RGBA', (s, s), (0,0,0,0))
    d = ImageDraw.Draw(img)
    r = int(s * radius_ratio)
    d.rounded_rectangle([0,0,s-1,s-1], radius=r, fill=(108,140,255,255))
    # 对角渐变：从左上 #6B8CFF 到右下 #7C5CFF
    grad = Image.new('RGBA', (s, s), (0,0,0,0))
    gd = ImageDraw.Draw(grad)
    for i in range(s):
        t = i / max(1, s-1)
        c = (int(107 + (124-107)*t), int(140 + (92-140)*t), int(255 + (255-255)*t), 255)
        gd.line([(0,i),(s,i)], fill=c)
    mask = img.split()[3]
    img.paste(grad, (0,0), mask)
    return img, s

def draw_glyph(img, s):
    # 中文字形「译」用微软雅黑粗体
    size = int(s * 0.60)
    try:
        font = ImageFont.truetype(r'C:\Windows\Fonts\msyhbd.ttc', size)
    except Exception:
        font = ImageFont.load_default()
    txt = '译'
    d = ImageDraw.Draw(img)
    try:
        bbox = d.textbbox((0,0), txt, font=font)
    except Exception:
        bbox = (0,0,size,size)
    w = bbox[2]-bbox[0]
    h = bbox[3]-bbox[1]
    x = (s - w) / 2 - bbox[0]
    y = (s - h) / 2 - bbox[1] - s*0.02
    # 白色字 + 轻微投影，深色界面上更清楚
    d.text((x+2, y+2), txt, font=font, fill=(30, 34, 52, 110))
    d.text((x, y), txt, font=font, fill=(255,255,255,255))
    return img

for px in (16, 32, 48, 128):
    big, s = rounded(px)
    big = draw_glyph(big, s)
    out = big.resize((px, px), Image.LANCZOS)
    out.save(os.path.join(OUT, f'{px}.png'))
    print('icon', px, 'ok')
