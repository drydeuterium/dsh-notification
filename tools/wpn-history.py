"""Windows の通知データベースを読み、トーストが実際に OS に登録されたかを確かめる。

「PowerShell は exit 0 なのにトーストが出ない」を切り分けるためのツール。
通知は `wpndatabase.db`（SQLite）に記録されるので、そこを直接見るのが一番確実。
WAL を落とすと最新のコミットが読めないので、`.db` / `-wal` / `-shm` をまとめてコピーする。

使い方:
    python tools/wpn-history.py                     # 既定のアプリ ID の直近 20 件
    python tools/wpn-history.py --limit 50
    python tools/wpn-history.py --app SomeApp.Aumid
    python tools/wpn-history.py --search "通知本文の一部"   # DB 全体を生バイト検索

`--search` は見つからなければ終了コード 1 を返すので、スクリプトから判定に使える。
"""
import argparse
import ctypes
import datetime
import os
import shutil
import sqlite3
import sys
import tempfile

DEFAULT_APP = "DeepSeekHarness.DesktopNotify"

QUNS = {
    1: "NOT_PRESENT",
    2: "BUSY（全画面アプリ等）",
    3: "D3D_FULLSCREEN",
    4: "PRESENTATION",
    5: "ACCEPTS_NOTIFICATIONS",
    6: "QUIET_TIME（集中モード）",
    7: "APP",
}


def notification_state() -> str:
    """SHQueryUserNotificationState: OS が今トーストを受け付ける状態か。"""
    try:
        state = ctypes.c_int(0)
        ctypes.windll.shell32.SHQueryUserNotificationState(ctypes.byref(state))
        return f"{state.value} ({QUNS.get(state.value, '?')})"
    except Exception as exc:  # noqa: BLE001
        return f"取得できません: {exc}"


def copy_database() -> str:
    src = os.path.join(os.environ["LOCALAPPDATA"], "Microsoft", "Windows", "Notifications", "wpndatabase.db")
    if not os.path.exists(src):
        raise SystemExit(f"通知データベースがありません: {src}")
    dest = os.path.join(tempfile.gettempdir(), "wpn-history.db")
    for suffix in ("", "-wal", "-shm"):
        target = dest + suffix
        if os.path.exists(target):
            os.remove(target)
        try:
            shutil.copy2(src + suffix, target)
        except FileNotFoundError:
            pass
    return dest


def filetime_to_local(value: int) -> str:
    """FILETIME（1601-01-01 起点の 100ns）をローカル時刻に。"""
    if not value:
        return "?"
    try:
        moment = datetime.datetime(1601, 1, 1) + datetime.timedelta(microseconds=value / 10)
        return (moment + datetime.timedelta(hours=9)).strftime("%Y-%m-%d %H:%M:%S")
    except Exception:  # noqa: BLE001
        return str(value)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--app", default=DEFAULT_APP, help=f"対象の AUMID（既定 {DEFAULT_APP}）")
    parser.add_argument("--limit", type=int, default=20, help="表示する件数（既定 20）")
    parser.add_argument("--search", default=None, help="DB 全体を生バイト検索する文字列")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    db = copy_database()

    print(f"通知の受付状態: {notification_state()}")
    print(f"AUMID: {args.app}\n")

    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        handlers = {int(r[0]): str(r[1]) for r in con.execute("select RecordId, PrimaryId from NotificationHandler")}
        handler_id = next((hid for hid, name in handlers.items() if name == args.app), None)
        if handler_id is None:
            print("この AUMID のハンドラはまだ登録されていません（＝一度も通知が届いていない）。")
        else:
            print(f"ハンドラ #{handler_id} が見つかりました。\n")
            rows = list(
                con.execute(
                    'select Id, HandlerId, ArrivalTime, Payload from Notification order by "Order" desc'
                )
            )
            shown = 0
            for _id, hid, arrival, payload in rows:
                if hid != handler_id:
                    continue
                text = payload.decode("utf-8", "replace") if isinstance(payload, bytes) else str(payload)
                texts = [t.split("</text>")[0] for t in text.split("<text>")[1:]]
                print(f"  {filetime_to_local(arrival)}  {' | '.join(texts)}")
                shown += 1
                if shown >= args.limit:
                    break
            if shown == 0:
                print("  （一覧に残っている通知はありません）")
    finally:
        con.close()

    if args.search:
        raw = b""
        for suffix in ("", "-wal"):
            with open(db + suffix, "rb") as handle:
                raw += handle.read()
        found = args.search.encode("utf-8") in raw
        print(f"\n生バイト検索 {args.search!r}: {'FOUND' if found else 'not found'}")
        print("（一覧から消えていても、WAL に書き込みが残っていれば FOUND になる）")
        return 0 if found else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
