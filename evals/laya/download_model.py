"""Fetch the pinned test checkpoint; verify files before using it offline."""
import hashlib
import json
from pathlib import Path
import sys
from urllib.request import urlopen

manifest = json.loads(Path(__file__).with_name("model-manifest.json").read_text())
target = Path(sys.argv[1])
for name, info in manifest["files"].items():
    path = target / name
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and hashlib.file_digest(path.open("rb"), "sha256").hexdigest() == info["sha256"]:
        print("verified", name, flush=True)
        continue
    url = f'https://huggingface.co/{manifest["repository"]}/resolve/{manifest["revision"]}/{name}'
    temporary = path.with_suffix(path.suffix + ".part")
    with urlopen(url, timeout=120) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    # Match the official Laya runtime's compatibility normalization. The manifest
    # records the post-normalization tokenizer config, all other files are verbatim.
    if name == "tokenizer/tokenizer_config.json":
        cfg = json.loads(temporary.read_text())
        changed = False
        if cfg.get("tokenizer_class") in (None, "TokenizersBackend"):
            cfg["tokenizer_class"] = "PreTrainedTokenizerFast"
            cfg.pop("backend", None)
            cfg.pop("is_local", None)
            changed = True
        if isinstance(cfg.get("extra_special_tokens"), list):
            cfg["extra_special_tokens"] = {f"extra_{i}": value for i, value in enumerate(cfg["extra_special_tokens"])}
            changed = True
        if changed:
            temporary.write_text(json.dumps(cfg, indent=2))
    actual = hashlib.file_digest(temporary.open("rb"), "sha256").hexdigest()
    if actual != info["sha256"] or temporary.stat().st_size != info["bytes"]:
        raise ValueError(f"Integrity check failed: {name}: {actual}")
    temporary.replace(path)
    print("downloaded and verified", name, flush=True)
