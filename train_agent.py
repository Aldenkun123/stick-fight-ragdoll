#!/usr/bin/env python3
"""
train_agent.py — Auto-trainer & Brain Exporter untuk Stick Fight AI
=====================================================================
Usage:
  python train_agent.py                          # latih 60 gen, simpan brain.json
  python train_agent.py --gens 120               # 120 generasi
  python train_agent.py --rounds 5               # 5 ronde x 60 gen
  python train_agent.py --gens 60 --rounds 10    # 10 ronde x 60 gen = 600 gen total
  python train_agent.py --input brain.json       # lanjut dari brain lama
  python train_agent.py --output my_ai.json      # simpan ke nama custom
  python train_agent.py --export-only brain.json # hanya lihat info brain tanpa melatih
  python train_agent.py --compare a.json b.json  # bandingkan dua brain
"""

import argparse
import json
import os
import subprocess
import sys
import time
import shutil
from datetime import datetime
from pathlib import Path

# =============================================================================
# CONFIG
# =============================================================================
SCRIPT_DIR   = Path(__file__).parent.resolve()
HEADLESS_JS  = SCRIPT_DIR / 'train_headless.js'
DEFAULT_OUT  = SCRIPT_DIR / 'brain.json'
BACKUP_DIR   = SCRIPT_DIR / 'brain_backups'
NODE_CMD     = shutil.which('node') or 'node'

# ANSI colours (disable on Windows without colorama)
if sys.platform != 'win32' or os.environ.get('TERM'):
    R  = '\033[0m'
    B  = '\033[1m'
    C  = '\033[36m'
    G  = '\033[32m'
    Y  = '\033[33m'
    RE = '\033[31m'
    M  = '\033[35m'
    DIM= '\033[2m'
else:
    R = B = C = G = Y = RE = M = DIM = ''

# =============================================================================
# HELPERS
# =============================================================================

def ts():
    return datetime.now().strftime('%H:%M:%S')

def log(icon, color, msg):
    print(f"{DIM}[{ts()}]{R} {color}{icon}{R} {msg}")

def progress_bar(current, total, width=40, fill='█', empty='░'):
    if total <= 0:
        return '[?]'
    pct  = min(current / total, 1.0)
    done = int(pct * width)
    bar  = fill * done + empty * (width - done)
    return f"{C}[{bar}]{R} {B}{int(pct*100):3d}%{R}"

def load_brain_info(path):
    """Baca metadata dari file brain JSON."""
    p = Path(path)
    if not p.exists():
        return None
    try:
        with open(p) as f:
            data = json.load(f)
        meta = data.get('meta', {})
        return {
            'path':     str(p),
            'gen':      meta.get('gen',     0),
            'trained':  meta.get('trained', 0),
            'fit':      meta.get('fit',     0),
            'pop_size': len(data.get('pop', [])),
            'hof_size': len(data.get('hof', [])),
            'genome_len': len(data.get('w', [])),
            'exported_at': data.get('exported_at', '-'),
            'size_kb':  round(p.stat().st_size / 1024, 1),
        }
    except Exception as e:
        return {'error': str(e)}

def print_brain_info(info, label='Brain'):
    if not info:
        log('✗', RE, f"{label}: file tidak ditemukan")
        return
    if 'error' in info:
        log('✗', RE, f"{label}: {info['error']}")
        return
    print(f"""
{B}{C}{'─'*52}{R}
{B} {label}: {info['path']}{R}
{'─'*52}
  Gen terakhir : {G}{info['gen']}{R}  (total dilatih: {info['trained']})
  Fitness terbaik : {G}{info['fit']}{R}
  Populasi       : {info['pop_size']} bot
  Hall of Fame   : {info['hof_size']} brain
  Genome length  : {info['genome_len']:,}
  Ukuran file    : {info['size_kb']} KB
  Diekspor       : {DIM}{info['exported_at']}{R}
{B}{C}{'─'*52}{R}""")

def backup_brain(path):
    """Simpan salinan brain ke folder backups."""
    p = Path(path)
    if not p.exists():
        return
    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    dest  = BACKUP_DIR / f"{p.stem}_{stamp}{p.suffix}"
    shutil.copy2(p, dest)
    return dest

def ensure_headless_js():
    if not HEADLESS_JS.exists():
        sys.exit(f"{RE}✗ Tidak ditemukan: {HEADLESS_JS}\n  Pastikan file train_headless.js ada di folder yang sama.{R}")

# =============================================================================
# CORE: satu ronde pelatihan
# =============================================================================

def run_training_round(gens, output, input_brain=None, verbose=False, round_num=1, total_rounds=1):
    """
    Jalankan satu ronde pelatihan via Node.js.
    Return dict hasil (dari JSON line terakhir dengan type=='done'), atau None jika gagal.
    """
    cmd = [
        NODE_CMD, str(HEADLESS_JS),
        '--gens',   str(gens),
        '--output', str(output),
    ]
    if input_brain and Path(input_brain).exists():
        cmd += ['--input', str(input_brain)]
    if verbose:
        cmd.append('--verbose')

    label = f"Ronde {round_num}/{total_rounds}"
    log('▶', C, f"{label} — {gens} generasi  →  {output}")

    result   = None
    start_t  = time.time()
    last_gen = 0
    last_fit = 0

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )

        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                if verbose:
                    print(f"  {DIM}{line}{R}")
                continue

            mtype = msg.get('type')

            if mtype == 'progress':
                g    = msg.get('gen', 0)
                fit  = msg.get('fit', 0)
                tot  = msg.get('total', gens)
                elapsed = time.time() - start_t
                speed   = g / elapsed if elapsed > 1 else 0
                eta_s   = (tot - g) / speed if speed > 0.1 else 0
                eta_str = f"{int(eta_s//60)}m{int(eta_s%60):02d}s" if eta_s > 0 else '...'
                bar     = progress_bar(g, tot)
                print(f"  {bar}  Gen {B}{g:>4}/{tot}{R}  fit={G}{fit:>7}{R}  "
                      f"{DIM}ETA {eta_str}  ({speed:.1f} gen/s){R}",
                      end='\r', flush=True)
                last_gen = g
                last_fit = fit

            elif mtype == 'done':
                print()  # newline setelah progress bar
                result = msg

            elif mtype == 'info':
                log('ℹ', C, msg.get('msg', ''))

            elif mtype == 'warn':
                log('⚠', Y, msg.get('msg', ''))

            elif mtype == 'error':
                print()  # newline
                log('✗', RE, msg.get('msg', ''))

        proc.wait()
        stderr_out = proc.stderr.read().strip()
        if stderr_out and verbose:
            print(f"{DIM}{stderr_out}{R}")

        if proc.returncode != 0 and result is None:
            print()
            log('✗', RE, f"Node.js keluar dengan kode {proc.returncode}")
            if stderr_out:
                print(f"  {RE}{stderr_out[:400]}{R}")
            return None

    except FileNotFoundError:
        sys.exit(f"{RE}✗ Node.js tidak ditemukan. Pastikan Node.js terinstall dan ada di PATH.{R}")
    except KeyboardInterrupt:
        print(f"\n{Y}⚠ Training dihentikan manual (Ctrl+C){R}")
        proc.terminate()
        return None

    elapsed = time.time() - start_t
    if result:
        log('✓', G, (
            f"{label} selesai dalam {elapsed:.1f}s — "
            f"Gen {result.get('gen',0)} | "
            f"Trained {result.get('trained',0)} | "
            f"Fit {result.get('fit',0)} | "
            f"Pop {result.get('pop_size',0)} | "
            f"HoF {result.get('hof_size',0)}"
        ))
    return result

# =============================================================================
# COMMANDS
# =============================================================================

def cmd_train(args):
    ensure_headless_js()

    output      = Path(args.output)
    total_rounds = args.rounds
    gens_per    = args.gens

    print(f"""
{B}{C}╔══════════════════════════════════════════════╗
║   Stick Fight AI — Auto Trainer & Exporter  ║
╚══════════════════════════════════════════════╝{R}
  Generasi/ronde : {B}{gens_per}{R}
  Ronde total    : {B}{total_rounds}{R}
  Output         : {B}{output}{R}
  Resume brain   : {B}{args.input or '(mulai baru)'}{R}
  Node.js        : {DIM}{NODE_CMD}{R}
""")

    # tampilkan info brain awal jika ada
    in_brain = args.input
    if in_brain:
        info = load_brain_info(in_brain)
        if info and 'error' not in info:
            print_brain_info(info, 'Brain yang akan dilanjutkan')

    total_trained = 0
    best_fit      = 0
    session_start = time.time()

    for rnd in range(1, total_rounds + 1):
        # backup sebelum ronde (jika file output sudah ada)
        if output.exists() and total_rounds > 1:
            bk = backup_brain(output)
            if bk:
                log('💾', DIM, f"Backup → {bk.name}")

        result = run_training_round(
            gens        = gens_per,
            output      = output,
            input_brain = str(output) if output.exists() else in_brain,
            verbose     = args.verbose,
            round_num   = rnd,
            total_rounds= total_rounds,
        )

        if result is None:
            log('✗', RE, f"Ronde {rnd} gagal. Hentikan training.")
            break

        total_trained += result.get('gen', 0)
        best_fit       = max(best_fit, result.get('fit', 0))

        # simpan snapshot bernomor jika --keep-snapshots
        if args.keep_snapshots and output.exists():
            snap_name = output.parent / f"{output.stem}_round{rnd:03d}{output.suffix}"
            shutil.copy2(output, snap_name)
            log('📸', DIM, f"Snapshot → {snap_name.name}")

    # ──── Ringkasan sesi ────
    elapsed = time.time() - session_start
    print(f"""
{B}{G}╔══════════════════════════════════════════════╗
║         SESI TRAINING SELESAI ✓             ║
╚══════════════════════════════════════════════╝{R}""")
    final_info = load_brain_info(output)
    print_brain_info(final_info, 'Brain Final')
    print(f"  Waktu total    : {B}{elapsed:.1f}s{R}  "
          f"({elapsed/60:.1f} menit)")
    print(f"  Gen di sesi ini: {B}{total_trained}{R}")
    print(f"  Fitness terbaik: {G}{best_fit}{R}\n")
    log('✓', G, f"Brain tersimpan → {output}")
    log('✓', G, "Import file ini ke game via tombol 'Impor Otak AI'")


def cmd_export_only(args):
    """Hanya tampilkan info dari file brain JSON (tanpa melatih)."""
    for path in args.files:
        info = load_brain_info(path)
        print_brain_info(info, path)


def cmd_compare(args):
    """Bandingkan dua file brain."""
    if len(args.files) < 2:
        sys.exit(f"{RE}✗ Butuh dua file: --compare a.json b.json{R}")
    a_info = load_brain_info(args.files[0])
    b_info = load_brain_info(args.files[1])
    print_brain_info(a_info, 'Brain A')
    print_brain_info(b_info, 'Brain B')

    if a_info and b_info and 'error' not in a_info and 'error' not in b_info:
        print(f"\n{B}Perbandingan:{R}")
        winner_fit  = 'A' if a_info['fit']     >= b_info['fit']     else 'B'
        winner_gen  = 'A' if a_info['trained'] >= b_info['trained'] else 'B'
        winner_pop  = 'A' if a_info['pop_size']>= b_info['pop_size'] else 'B'
        print(f"  Fitness lebih tinggi : {G}{winner_fit}{R}  "
              f"(A={a_info['fit']} vs B={b_info['fit']})")
        print(f"  Lebih banyak dilatih : {G}{winner_gen}{R}  "
              f"(A={a_info['trained']} vs B={b_info['trained']})")
        print(f"  Populasi lebih besar : {G}{winner_pop}{R}  "
              f"(A={a_info['pop_size']} vs B={b_info['pop_size']})")
        rec = 'A' if a_info['fit'] >= b_info['fit'] else 'B'
        print(f"\n  {B}Rekomendasi: Gunakan Brain {G}{rec}{R}")


def cmd_list_backups(args):
    """Daftar semua backup yang tersimpan."""
    if not BACKUP_DIR.exists():
        log('ℹ', C, 'Belum ada backup tersimpan.')
        return
    files = sorted(BACKUP_DIR.glob('*.json'), key=lambda p: p.stat().st_mtime, reverse=True)
    if not files:
        log('ℹ', C, 'Folder backup kosong.')
        return
    print(f"\n{B}{C}Backup tersimpan ({len(files)} file):{R}")
    for f in files:
        info = load_brain_info(f)
        if info and 'error' not in info:
            print(f"  {f.name:<50} {DIM}gen={info['gen']:>4}  fit={info['fit']:>7}  {info['size_kb']} KB{R}")
        else:
            print(f"  {f.name}")
    print()


# =============================================================================
# CLI PARSER
# =============================================================================

def build_parser():
    p = argparse.ArgumentParser(
        prog='train_agent.py',
        description='Auto-trainer & Brain Exporter untuk Stick Fight AI',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = p.add_subparsers(dest='command')

    # ── train (default) ──
    tr = sub.add_parser('train', help='Latih AI (default)')
    tr.add_argument('--gens',   type=int, default=60,    help='Generasi per ronde (default: 60)')
    tr.add_argument('--rounds', type=int, default=1,     help='Jumlah ronde (default: 1)')
    tr.add_argument('--output', default=str(DEFAULT_OUT),help='File output brain JSON')
    tr.add_argument('--input',  default='',              help='Lanjutkan dari brain JSON ini')
    tr.add_argument('--keep-snapshots', action='store_true', help='Simpan snapshot per ronde')
    tr.add_argument('--verbose', action='store_true',    help='Tampilkan log detail dari Node.js')

    # ── export-only ──
    ex = sub.add_parser('info', help='Tampilkan info brain JSON tanpa melatih')
    ex.add_argument('files', nargs='+', help='File brain JSON')

    # ── compare ──
    cp = sub.add_parser('compare', help='Bandingkan dua brain JSON')
    cp.add_argument('files', nargs=2, help='Dua file brain JSON')

    # ── backups ──
    sub.add_parser('backups', help='Daftar semua backup')

    return p


def main():
    parser = build_parser()
    # Tangani mode "shortcut" tanpa subcommand (langsung --gens dll)
    # agar tetap kompatibel: python train_agent.py --gens 120
    raw = sys.argv[1:]
    first = raw[0] if raw else ''
    if not first or first.startswith('-'):
        # inject 'train' as default subcommand
        sys.argv.insert(1, 'train')

    args = parser.parse_args()

    if args.command == 'train' or args.command is None:
        cmd_train(args)
    elif args.command == 'info':
        cmd_export_only(args)
    elif args.command == 'compare':
        cmd_compare(args)
    elif args.command == 'backups':
        cmd_list_backups(args)
    else:
        parser.print_help()


if __name__ == '__main__':
    main()
