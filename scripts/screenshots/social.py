# Builds docs/social-preview.png (1280x640) for GitHub's repository social preview.
# python3 scripts/screenshots/social.py  (needs Pillow and the Inter font)
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os
root = os.path.join(os.path.dirname(__file__), '..', '..')
W, H = 1280, 640
img = Image.new('RGB', (W, H), (17, 24, 19))
d = ImageDraw.Draw(img)
for y in range(H):  # soft vertical gradient
    t = y / H
    d.line([(0, y), (W, y)], fill=(int(18 + 10 * t), int(38 - 12 * t), int(24 - 4 * t)))
F = '/usr/share/fonts/opentype/inter/'
title = ImageFont.truetype(F + 'InterDisplay-Bold.otf', 76)
sub = ImageFont.truetype(F + 'Inter-Medium.otf', 28)
small = ImageFont.truetype(F + 'Inter-Medium.otf', 21)
icon = Image.open(os.path.join(root, 'build', 'icon.png')).convert('RGBA').resize((96, 96), Image.LANCZOS)
img.paste(icon, (72, 86), icon)
d.text((186, 92), 'Blockyard', font=title, fill=(255, 255, 255))
d.text((74, 214), 'Host a Minecraft server on your Mac,', font=sub, fill=(214, 233, 218))
d.text((74, 252), 'without the terminal.', font=sub, fill=(214, 233, 218))
y = 330
for line in ['Paper, Fabric, Forge, NeoForge and more', 'Console, players, plugins, stats', 'Friends anywhere + Bedrock crossplay', 'Free and open source · Apple Silicon']:
    d.ellipse((76, y + 9, 86, y + 19), fill=(63, 185, 80))
    d.text((100, y), line, font=small, fill=(190, 210, 195))
    y += 42
shot = Image.open(os.path.join(root, 'docs', 'screenshots', '03-stats.png')).convert('RGB')
shot = shot.resize((1280, 800), Image.LANCZOS).crop((0, 0, 1280, 800))
shot = shot.resize((760, 475), Image.LANCZOS)
mask = Image.new('L', shot.size, 0)
ImageDraw.Draw(mask).rounded_rectangle((0, 0, shot.size[0], shot.size[1]), 14, fill=255)
shadow = Image.new('RGBA', (shot.size[0] + 80, shot.size[1] + 80), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((40, 50, shot.size[0] + 40, shot.size[1] + 50), 14, fill=(0, 0, 0, 150))
shadow = shadow.filter(ImageFilter.GaussianBlur(22))
x0, y0 = 640, 110
img.paste(shadow, (x0 - 40, y0 - 40), shadow)
img.paste(shot, (x0, y0), mask)
img.save(os.path.join(root, 'docs', 'social-preview.png'), optimize=True)
print('ok')
