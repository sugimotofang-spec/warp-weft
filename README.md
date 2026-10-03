# 經緯 Warp & Weft

一根紗如何變成一雙鞋。即時運算的織布機與材料實驗室，加一支 30 秒短片。

*A real-time loom and fabric lab, from a single yarn to a running shoe, plus a 30-second film.*

## 內容

| 檔案 | 說明 |
|---|---|
| `index.html` | 互動頁（中文／English 雙語）：織布機、組織實驗室、布料懸垂、鞋面解剖 |
| `film.html` | 30 秒短片的畫面來源，可直接在瀏覽器即時播放；加 `?lang=en` 看英文版 |
| `fabric-core.js` | 共用引擎：組織庫、緞紋提花、物性公式、WebGL2 紗線級著色器、鞋型 |
| `render_film.py` | 用 headless Chrome 逐格擷取 `film.html`，再用 ffmpeg 合成 MP4（`--lang en` 輸出英文版） |
| `soundtrack.py` | 依 `cues.json` 用 numpy 合成配樂 |
| `warp-weft-30s.mp4`、`warp-weft-30s-en.mp4` | 720p 版短片（中文、英文） |

語言：網頁預設依瀏覽器語言，也可以用 `?lang=en` 或 `?lang=zh` 指定，右上角有切換鈕，選擇會記在瀏覽器裡。

## 本機執行

```bash
python -m http.server 8000
# 開啟 http://localhost:8000/
```

需要支援 WebGL2 的瀏覽器。

## 重新算圖

需要 Python 3、`playwright`、`numpy`、Chrome 和 ffmpeg。

```bash
python render_film.py            # 中文版
python render_film.py --lang en  # 英文版
```

## 備註

頁面上的克重、覆蓋率等數字，是以聚酯長纖（密度 1.38 g/cm³、填充係數 0.75）和通用紡織公式估算的示意值，不代表任何公司或產品的規格。
