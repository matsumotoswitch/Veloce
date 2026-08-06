import re

with open('src/viewer.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_code = '''  const img = viewerUI.elements.viewerImg;
  const rect = img.getBoundingClientRect();
  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const baseLeft = rect.left - viewerState.currentTranslateX;
  const baseTop = rect.top - viewerState.currentTranslateY;
  const baseRight = rect.right - viewerState.currentTranslateX;
  const baseBottom = rect.bottom - viewerState.currentTranslateY;'''

new_code = '''  const winW = window.innerWidth;
  const winH = window.innerHeight;
  const { width: natW, height: natH } = getNaturalDimensions();
  const comp = viewerState.compensateScale || 1.0;
  
  const scaledW = natW * viewerState.currentScale * comp;
  const scaledH = natH * viewerState.currentScale * comp;

  const baseLeft = (winW - scaledW) / 2;
  const baseTop = (winH - scaledH) / 2;
  const baseRight = baseLeft + scaledW;
  const baseBottom = baseTop + scaledH;
  
  const rect = { width: scaledW, height: scaledH };'''

content = content.replace(old_code, new_code)

with open('src/viewer.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Success')
