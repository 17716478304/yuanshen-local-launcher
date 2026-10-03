"""Collect exact license texts from locked installed dependencies, without following links."""
from pathlib import Path
import shutil
import importlib.metadata
out = Path('sidecar/licenses/dependencies')
out.mkdir(parents=True, exist_ok=True)
for package in Path('node_modules/.pnpm').iterdir():
    if not package.is_dir():
        continue
    for text in list(package.glob('node_modules/*/*')) + list(package.glob('node_modules/@*/*/*')):
        if text.is_file() and text.name.lower().startswith(('license', 'copying', 'notice')):
            target = out / package.name / text.relative_to(package / 'node_modules')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(text, target)
for package in importlib.metadata.distributions():
    for item in package.files or []:
        if any(part.lower().startswith(('license', 'copying', 'notice')) for part in item.parts):
            text = Path(package.locate_file(item))
            if text.is_file():
                target = out / ('python-' + package.metadata['Name']) / text.name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(text, target)
