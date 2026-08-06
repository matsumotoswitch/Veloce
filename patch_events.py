import re

with open('src/viewer.js', 'r', encoding='utf-8') as f:
    content = f.read()

# For mousemove
content = content.replace('      viewerUI.updateImageRendering();\n      clampTranslate();\n      viewerUI.updateImageRendering();', '      clampTranslate();\n      viewerUI.updateImageRendering();')

# For wheel
content = content.replace('    viewerUI.updateImageRendering();\n    clampTranslate();\n    viewerUI.updateImageRendering();', '    clampTranslate();\n    viewerUI.updateImageRendering();')

with open('src/viewer.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Success')
