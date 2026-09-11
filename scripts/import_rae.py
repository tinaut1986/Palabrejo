#!/usr/bin/env python3
"""
Import Spanish RAE words into Palabrejo's MariaDB.

Pipeline:
  1. Download raw RAE file (JorgeDuenasLerin/diccionario-espanol-txt, allwords.txt)
  2. parse_rae.py -> base words + feminine candidates
  3. Download reference list (an-array-of-spanish-words, ~636k real word strings)
  4. Filter: keep all base words (RAE lemma => definitely real) + feminine
     candidates that appear in the reference list (normalized). This avoids
     junk like "niñña" while keeping real feminines: niña, profesora, previa...
  5. Import the clean list into the `words` table.

Usage:
  python3 import_rae.py --download   # full pipeline (download + parse + import)
  python3 import_rae.py --skip-download  # use cached files, re-import only
  python3 import_rae.py --file <clean-list>  # import a pre-built clean list
"""

import os
import re
import subprocess
import sys
import unicodedata
import urllib.request

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)

RAE_URL = "https://raw.githubusercontent.com/JorgeDuenasLerin/diccionario-espanol-txt/master/data/allwords.txt"
REF_URL = "https://raw.githubusercontent.com/words/an-array-of-spanish-words/master/index.json"

RAE_RAW = os.path.join(SCRIPT_DIR, "allwords_rae.txt")
WORDS_RAW = os.path.join(SCRIPT_DIR, "words_raw.txt")
REF_FILE = os.path.join(SCRIPT_DIR, "words_ref.json")
CLEAN_FILE = os.path.join(SCRIPT_DIR, "words_clean.txt")

VALID_RE = re.compile(r'^[a-zñáéíóúü]{2,15}$')


def download(url, dest, label):
    print(f"Downloading {label} from {url} ...")
    urllib.request.urlretrieve(url, dest)
    print(f"  -> {dest}")


def parse_rae_raw():
    sys.path.insert(0, SCRIPT_DIR)
    import parse_rae
    bases, fems = parse_rae.parse_file(RAE_RAW)
    return bases, fems


def load_reference(path):
    import json
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    ref = set()
    for w in data:
        w = str(w).lower().strip()
        if w and VALID_RE.match(w) is None:
            continue
        if w:
            # normalize both ñ/accents for fuzzy matching
            ref.add(''.join(c for c in unicodedata.normalize('NFD', w) if not unicodedata.combining(c)).replace('ñ', 'n'))
    print(f"Reference list: {len(ref)} normalized entries")
    return ref


def normalize_for_match(w):
    return ''.join(c for c in unicodedata.normalize('NFD', w)
                   if not unicodedata.combining(c)).replace('ñ', 'n')


def build_clean_list(bases, fems, ref):
    keep = set()
    # Base words are RAE lemmas => trust them entirely
    keep |= bases
    # Feminine candidates: keep only those present in the reference list
    added = 0
    for f in fems:
        if f in bases:
            continue
        nf = normalize_for_match(f)
        if nf in ref:
            keep.add(f)
            added += 1
    print(f"Kept {added} verified feminines out of {len(fems)} candidates")
    for w in sorted(keep):
        if not VALID_RE.match(w):
            keep.discard(w)
    return sorted(keep)


def ensure_mariadb_client():
    for client in ("mariadb", "mysql"):
        try:
            subprocess.run([client, "--version"], capture_output=True, check=True)
            return client
        except (FileNotFoundError, subprocess.CalledProcessError):
            continue
    print("ERROR: mariadb/mysql client not found on this machine.")
    sys.exit(1)


def read_credentials():
    config_path = os.path.join(PROJECT_DIR, "config.js")
    config = {}
    with open(config_path, "r", encoding="utf-8") as f:
        for line in f:
            m = re.match(r"(\w+):\s*'([^']*)'", line.strip().rstrip(","))
            if m:
                config[m.group(1)] = m.group(2)
    return config


def build_sql(words):
    chunks = []
    batch = []
    for i, w in enumerate(words):
        batch.append(f"  ('{w}', {len(w)})")
        if len(batch) == 20000:
            chunks.append("INSERT IGNORE INTO words (word, length) VALUES\n"
                          + ",\n".join(batch) + ";")
            batch = []
    if batch:
        chunks.append("INSERT IGNORE INTO words (word, length) VALUES\n"
                      + ",\n".join(batch) + ";")
    return chunks


def import_chunks(chunks, client):
    cfg = read_credentials()
    host = os.environ.get("DB_HOST", cfg.get("host", "localhost"))
    user = cfg.get("user", "root")
    password = cfg.get("password", "")
    database = cfg.get("database", "palabrejo_db")
    print(f"Importing into {database}@{host} as {user} ...")
    for i, chunk in enumerate(chunks):
        proc = subprocess.Popen(
            [client, f"-h{host}", f"-u{user}", f"-p{password}",
             "--skip-ssl", database],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True,
        )
        _, err = proc.communicate(input=chunk)
        if proc.returncode != 0:
            print(f"DB error: {err}")
            sys.exit(1)
        print(f"  batch {i + 1}/{len(chunks)} OK")
    print("Import complete.")


def main():
    download_flag = "--download" in sys.argv
    file_arg = None
    for i, a in enumerate(sys.argv):
        if a == "--file" and i + 1 < len(sys.argv):
            file_arg = sys.argv[i + 1]

    if file_arg:
        clean_path = file_arg
    elif download_flag:
        download(RAE_URL, RAE_RAW, "RAE raw file")
        download(REF_URL, REF_FILE, "reference word list")
        bases, fems = parse_rae_raw()
        ref = load_reference(REF_FILE)
        clean = build_clean_list(bases, fems, ref)
        clean_path = CLEAN_FILE
        with open(clean_path, "w", encoding="utf-8") as f:
            f.write("\n".join(clean) + "\n")
        print(f"Clean list -> {clean_path}")
    else:
        if not os.path.exists(CLEAN_FILE):
            print("No clean file found. Run with --download first.")
            sys.exit(1)
        clean_path = CLEAN_FILE

    with open(clean_path, "r", encoding="utf-8") as f:
        words = sorted({w.strip().lower() for w in f if w.strip()})
    words = [w for w in words if VALID_RE.match(w)]
    print(f"Loaded {len(words)} clean Spanish words.")

    chunks = build_sql(words)
    client = ensure_mariadb_client()
    import_chunks(chunks, client)
    print(f"DONE. {len(words)} words ready.")


if __name__ == "__main__":
    main()