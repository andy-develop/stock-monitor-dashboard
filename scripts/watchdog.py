#!/usr/bin/env python3
"""
股票监控看板状态变化 watchdog
- 拉取 GitHub Pages 上的看板页面
- 提取 window.DASHBOARD_DATA JSON 数据
- 解析每个窗口、每个买入/卖出区域、每个 alert 的颜色状态
- 与上次记录的状态对比，发生变化时输出消息（供 cron 推送）
- 新增股票/ETF 窗口会自动识别，无需修改脚本
"""

import json
import os
import urllib.request
from datetime import datetime, timezone

URL = "https://andy-develop.github.io/stock-monitor-dashboard/"
STATE_FILE = os.path.expanduser("~/.hermes/cron/state/stock-monitor-dashboard.json")


def fetch_html():
    req = urllib.request.Request(
        URL,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            )
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def extract_dashboard_data(html):
    """从页面 HTML 中提取 window.DASHBOARD_DATA 数组"""
    marker = "window.DASHBOARD_DATA = "
    start = html.find(marker)
    if start == -1:
        raise ValueError("页面中未找到 window.DASHBOARD_DATA")
    start += len(marker)

    depth = 0
    in_string = False
    escape = False
    end = start
    for i in range(start, len(html)):
        ch = html[i]
        if escape:
            escape = False
            continue
        if ch == "\\":
            escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch in "[{":
            depth += 1
        elif ch in "}]":
            depth -= 1
            if depth == 0:
                end = i + 1
                break

    return json.loads(html[start:end])


def parse_state(windows):
    """把 DASHBOARD_DATA 解析成窗口 -> 区域 -> alert 的层级结构"""
    parsed = []
    for w in windows:
        window_name = f"{w['stockName']} ({w['stockCode']})"
        sections = []

        # 买入区域
        buy_alerts = w.get("buyAlerts", [])
        if buy_alerts or w.get("buySectionTitle"):
            sections.append(
                {
                    "title": w.get("buySectionTitle", "买入"),
                    "alerts": buy_alerts,
                }
            )

        # 卖出区域
        sell_alert = w.get("sellAlert")
        if sell_alert or w.get("sellSectionTitle"):
            sections.append(
                {
                    "title": w.get("sellSectionTitle", "卖出"),
                    "alerts": [sell_alert] if sell_alert else [],
                }
            )

        parsed.append({"name": window_name, "sections": sections})
    return parsed


def section_header_type(alerts):
    """根据区域内 alert 类型推断区域标题栏颜色"""
    types = {a.get("type", "success") for a in alerts}
    if "danger" in types:
        return "danger"
    if "warning" in types:
        return "warning"
    if "yellow" in types:
        return "yellow"
    return "normal"


def flatten_state(windows):
    """把层级结构打平成可对比的 key -> type 列表"""
    entries = []
    for w in windows:
        for s in w["sections"]:
            base_key = f"{w['name']}|{s['title']}"
            header_type = section_header_type(s["alerts"])
            entries.append(
                {
                    "key": base_key + "|_header",
                    "window": w["name"],
                    "section": s["title"],
                    "title": s["title"],
                    "type": header_type,
                }
            )
            for idx, a in enumerate(s["alerts"]):
                entries.append(
                    {
                        "key": f"{base_key}|{idx}",
                        "window": w["name"],
                        "section": s["title"],
                        "title": a.get("title", ""),
                        "type": a.get("type", "success"),
                    }
                )
    return entries


def load_state():
    if not os.path.exists(STATE_FILE):
        return None
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_state(entries):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(
            {
                "updated_at": datetime.now(timezone.utc).isoformat(),
                "entries": entries,
            },
            f,
            ensure_ascii=False,
            indent=2,
        )


def compare_states(old_entries, new_entries):
    old_map = {e["key"]: e for e in (old_entries or [])}
    new_map = {e["key"]: e for e in new_entries}

    changes = []
    for key, new_e in new_map.items():
        old_e = old_map.get(key)
        if old_e is None:
            changes.append(
                {
                    "type": "added",
                    "window": new_e["window"],
                    "section": new_e["section"],
                    "title": new_e["title"],
                    "old_type": None,
                    "new_type": new_e["type"],
                }
            )
        elif old_e["type"] != new_e["type"]:
            changes.append(
                {
                    "type": "changed",
                    "window": new_e["window"],
                    "section": new_e["section"],
                    "title": new_e["title"],
                    "old_type": old_e["type"],
                    "new_type": new_e["type"],
                }
            )

    for key, old_e in old_map.items():
        if key not in new_map:
            changes.append(
                {
                    "type": "removed",
                    "window": old_e["window"],
                    "section": old_e["section"],
                    "title": old_e["title"],
                    "old_type": old_e["type"],
                    "new_type": None,
                }
            )

    return changes


def type_emoji(t):
    return {
        "danger": "🔴",
        "warning": "🟠",
        "yellow": "🟡",
        "success": "🟢",
        "normal": "⚪",
    }.get(t, "⚪")


def format_message(changes, is_first_run, counts):
    lines = []
    if is_first_run:
        lines.append("📝 股票监控看板 watchdog 已启动并记录初始状态")
    else:
        lines.append("🚨 股票监控看板状态发生变化")
    lines.append("")

    if is_first_run:
        lines.append(
            f"当前共监控 {counts['windows']} 个窗口、{counts['sections']} 个区域、{counts['alerts']} 个信号："
        )
        lines.append("")

    for c in changes:
        if c["type"] == "changed":
            lines.append(
                f"{type_emoji(c['old_type'])} → {type_emoji(c['new_type'])} "
                f"{c['window']} / {c['section']} / {c['title']}"
            )
        elif c["type"] == "added":
            lines.append(
                f"➕ 新增 {type_emoji(c['new_type'])} "
                f"{c['window']} / {c['section']} / {c['title']}"
            )
        elif c["type"] == "removed":
            lines.append(
                f"➖ 移除 {type_emoji(c['old_type'])} "
                f"{c['window']} / {c['section']} / {c['title']}"
            )

    lines.append("")
    lines.append(f"页面：{URL}")
    return "\n".join(lines)


def main():
    try:
        html = fetch_html()
        windows = extract_dashboard_data(html)
        parsed = parse_state(windows)
        new_entries = flatten_state(parsed)

        old_state = load_state()
        old_entries = old_state.get("entries") if old_state else None

        changes = compare_states(old_entries, new_entries)
        is_first_run = old_entries is None

        counts = {
            "windows": len(parsed),
            "sections": sum(len(w["sections"]) for w in parsed),
            "alerts": sum(
                len(s["alerts"]) for w in parsed for s in w["sections"]
            ),
        }

        if is_first_run or changes:
            print(format_message(changes, is_first_run, counts))
        # 无变化时保持静默，cron 不会推送空消息

        save_state(new_entries)
    except Exception as e:
        print(f"❌ 股票监控看板 watchdog 运行失败：{e}")


if __name__ == "__main__":
    main()
