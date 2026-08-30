# 開発フロー(GitHub Flow)

このリポジトリは **GitHub Flow** で運用する。`main` は常にデプロイ可能(= プラグインとして読み込める)状態を保つ。

## ブランチ

- `main` … 唯一の長命ブランチ。直接 push しない(整備期の例外を除く)。
- `feat/<短い説明>` … 機能追加(例 `feat/slack-search`)
- `fix/<短い説明>` … バグ修正
- `docs/<短い説明>` … ドキュメントのみ
- `chore/<短い説明>` … 設定・依存・雑務

## 手順

1. `main` を最新化: `git switch main && git pull`
2. ブランチを切る: `git switch -c feat/xxx`
3. 小さくコミットする(下記メッセージ規約)。
4. push して Pull Request を作成する。PR テンプレートを埋める。
5. セルフレビュー + CI(あれば)を通す。
6. **Squash and merge** で `main` に取り込む。ブランチは削除。
7. リリース時に `git tag vX.Y.Z` を打つ(セマンティックバージョニング)。

## コミットメッセージ

Conventional Commits に寄せる:

```
feat: Slack 横断検索を追加
fix: esa チーム名の抽出が失敗するケースを修正
docs: ROADMAP に Phase 4 を追記
chore: mcp-server の依存を更新
```

## レビュー観点

- 依存ゼロ原則(`scripts/` は追加 `npm install` 不要)を崩していないか。
- 副作用(カレンダー書き込み・メッセージ送信)に事前確認が入っているか。
- 秘密情報を `.env` 以外に書いていないか(`.env` は gitignore 済み)。
- スキルは手順が番号付きで、停止条件・出典明記があるか。

## リリース

`main` にマージ済みの変更がまとまったら:

```bash
git switch main && git pull
git tag -a v0.2.0 -m "検索基盤 + Slack 連携"
git push --tags
```

`.claude-plugin/plugin.json` の `version` も合わせて上げる。
