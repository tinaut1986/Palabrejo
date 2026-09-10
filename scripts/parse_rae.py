#!/usr/bin/env python3
"""
Parse the RAE raw word file into base words + feminine candidates.

Source: https://github.com/JorgeDuenasLerin/diccionario-espanol-txt
  raw file: data/allwords.txt (~94k entries)

RAE compact notation covered:
  - "niño, ña"          -> base "niño" + feminine candidates
  - "-áceo, a"          -> EXCLUDED (word-forming suffix after "-")
  - "a capela", "ab initio" -> EXCLUDED (multi-word locución)
  - "a-"                -> EXCLUDED (prefix)
  - "‒́cola"            -> EXCLUDED (suffix/odd entry)
  - "abreviado"         -> kept as a base word

The feminine candidates are generated with several heuristics because the
RAE notation is ambiguous (e.g. "niño, ña" -> niña, "profesor, ra" -> profesora,
"previo, via" -> previa). They are NOT all real words: a post-filter step
(see import_rae.py) keeps only those found in a reference word list.

Usage:
  python3 parse_rae.py [input.txt] [output.txt]
  Defaults: allwords_rae.txt -> words_raw.txt
"""

import os
import re
import sys
import unicodedata

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_INPUT = os.path.join(SCRIPT_DIR, "allwords_rae.txt")
DEFAULT_OUTPUT = os.path.join(SCRIPT_DIR, "words_raw.txt")

VALID_RE = re.compile(r'^[a-zñáéíóúü]{2,15}$')
INFLECTION_RE = re.compile(r'^([a-zñáéíóúü]+), ([a-zñáéíóúü]+)$')


def normalize_noaccents(w):
    """Strip accents/combining marks for comparison used in filtering."""
    return ''.join(c for c in unicodedata.normalize('NFD', w)
                   if not unicodedata.combining(c)).replace('ñ', 'n')


def feminine_candidates(base, suffix):
    """Heuristics to produce plausible feminine forms. Union of rules; the
    correct form (if any) will surface after reference filtering."""
    cands = set()
    # rule A: drop last char of base, append last char of suffix  (niño->niña, previa)
    if len(base) > 1:
        cands.add(base[:-1] + suffix[-1])
    # rule B: drop last char of base, append whole suffix        (profesor->profesora)
    if len(base) > 1:
        cands.add(base[:-1] + suffix)
    # rule C: drop 2 chars of base, append whole suffix          (jarameño->jarameña)
    if len(base) > 2:
        cands.add(base[:-2] + suffix)
    # rule D: drop len(suffix) chars, append whole suffix        (x variants)
    if len(base) > len(suffix):
        cands.add(base[:-len(suffix)] + suffix)
    return {c for c in cands if VALID_RE.match(c)}


def parse_line(raw_line):
    """Return (bases, fenimine_candidates) for one RAE entry."""
    line = raw_line.strip()
    if not line:
        return set(), set()
    bottomline = line.lower()

    m = INFLECTION_RE.match(bottomline)
    if m:
        base, suffix = m.groups()
        # Compound/suffix entries where the suffix itself starts with '-'
        # (e.g. "-áceo, a"): exclude whole entry.
        if base.startswith('-'):
            return set(), set()
        return {base}, feminine_candidates(base, suffix)

    # Multi-word locuciones
    if ' ' in line:
        return set(), set()

    # Suffixes / prefixes
    if line.startswith('-') or line.startswith('‒') or line.endswith('-'):
        return set(), set()

    w = line.strip()
    if w and VALID_RE.match(w):
        return {w}, set()
    return set(), set()


def parse_file(input_path):
    bases = set()
    fems = set()
    with open(input_path, "r", encoding="utf-8") as f:
        for line in f:
            b, f_ = parse_line(line)
            bases |= b
            fems |= f_
    return bases, fems


def main():
    input_path = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_INPUT
    output_path = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUTPUT

    if not os.path.exists(input_path):
        print(f"ERROR: input not found: {input_path}")
        sys.exit(1)

    bases, fems = parse_file(input_path)
    all_words = bases | fems
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("\n".join(sorted(all_words)) + "\n")

    print(f"Bases: {len(bases)} | Feminine candidates: {len(fems)}")
    print(f"Total raw candidates -> {output_path}")
    print(f"  ñ words: {sum(1 for w in all_words if 'ñ' in w)}")


if __name__ == "__main__":
    main()