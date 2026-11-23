"""Collect redistributable dependencies' installed notices for the Mac bundle."""
from importlib.metadata import distributions
from pathlib import Path
import platform
import shutil
import sys
from urllib.request import urlopen


def main(root):
    root.mkdir(parents=True, exist_ok=True)
    found = set()
    for package in distributions():
        name = package.metadata["Name"]
        files = {}
        for file in package.files or ():
            posix = file.as_posix()
            if ".dist-info/" not in posix:
                continue
            relative = posix.split(".dist-info/", 1)[1]
            if relative.startswith("licenses/") or relative.lower().startswith(("license", "copying", "notice")):
                path = file.locate()
                if path.is_file():
                    files[relative] = path
        if files:
            found.add(name.lower())
            for relative, source in files.items():
                dest = root / name / relative
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, dest)
    required = {"pywebview", "pillow", "pyinstaller", "pyobjc-core", "pyobjc-framework-cocoa", "pyobjc-framework-webkit"}
    missing = required - found
    if missing:
        raise RuntimeError("Missing dependency notices: " + ", ".join(sorted(missing)))
    installed = Path(sys.base_prefix) / "LICENSE.txt"
    if installed.is_file():
        shutil.copyfile(installed, root / "CPython.txt")
    else:
        release = platform.python_version()
        with urlopen(f"https://raw.githubusercontent.com/python/cpython/v{release}/LICENSE", timeout=25) as res:
            (root / "CPython.txt").write_bytes(res.read())


if __name__ == "__main__":
    main(Path(sys.argv[1]))
