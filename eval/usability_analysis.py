"""Summarise usability from server logs and (optionally) a SUS questionnaire.

Usage:
    python eval/usability_analysis.py [--log logs/events.jsonl] [--sus eval/sus.csv]

SUS csv columns: participant,group,q1..q10   (answers 1-5;
group e.g. screenreader / sighted)
"""
import argparse
import csv
import json
import statistics as st
from collections import defaultdict


def logs(path):
    by = defaultdict(list)
    for line in open(path):
        r = json.loads(line)
        if r["event"] == "verify":
            by["haptic"].append(r)
    print("\nHaptic challenge outcomes")
    print(f"{'n':>5}{'success':>10}{'expired':>9}"
          f"{'median s':>10}{'median replays':>16}")
    for mode, rows in by.items():
        ok = [r for r in rows if r["ok"]]
        exp = sum(r["reason"] == "expired" for r in rows)
        t = st.median(r["server_s"] for r in ok) if ok else float("nan")
        rp = st.median(r["replays"] or 0 for r in rows)
        print(f"{len(rows):>5}{len(ok)/len(rows):>10.0%}{exp:>9}"
              f"{t:>10.1f}{rp:>16.0f}")


def sus_score(row):
    odd = sum(int(row[f"q{i}"]) - 1 for i in range(1, 11, 2))
    even = sum(5 - int(row[f"q{i}"]) for i in range(2, 11, 2))
    return (odd + even) * 2.5


def sus(path):
    groups = defaultdict(list)
    for row in csv.DictReader(open(path)):
        groups[row["group"]].append(sus_score(row))
    print("\nSUS (68 = industry average)")
    for g, s in groups.items():
        print(f"  {g:<14} n={len(s):<3} mean={st.mean(s):5.1f}  "
              f"sd={st.pstdev(s):4.1f}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--log", default="logs/events.jsonl")
    p.add_argument("--sus")
    a = p.parse_args()
    logs(a.log)
    if a.sus:
        sus(a.sus)