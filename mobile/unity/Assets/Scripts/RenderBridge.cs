using System;
using System.Collections;
using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Networking;
using UnityEngine.UI;
using TMPro;

/// <summary>
/// guidey spatial UI bridge: RN 側の Block を XREAL グラスの World Space に描画する。
///
/// RN からの postMessage("RenderBridge", "ShowBlocks", json) を受け取り、
/// json.args.blocks を走査して TextMeshPro / RawImage Prefab を生成、
/// VerticalLayoutGroup を持つコンテナ (textContainer / mediaContainer) に積む。
///
/// === シーン前提 (mobile/unity/README.md の Phase 2 手順参照) ===
/// - XR Origin (XREAL XR Loader が MainCamera を Stereo に切り替える)
/// - World Space Canvas を XR Origin 子 (or 独立) に配置、カメラ前方 2m
///   - RenderMode = WorldSpace
///   - Rect Transform 幅/高さ ~ 2.0 x 1.2 (worldUnits), Scale = 0.001 あたり
/// - Canvas 下に TextContainer (VerticalLayoutGroup) と MediaContainer を配置
/// - TextBlockPrefab (TextMeshProUGUI), ImageBlockPrefab (RawImage + 下にキャプション TMP)
///   を Project 側で作っておき、本スクリプトの Inspector に差す
///
/// === 描画更新戦略 ===
/// RN 側の activeBlocks は頻繁に更新される (LLM ストリーム等)。
/// 毎回 Destroy→Instantiate だと GC/再レイアウトが重いので、
/// 同数・同種なら既存を in-place で書き換える単純プールを採用。
/// </summary>
public class RenderBridge : MonoBehaviour
{
    // === Inspector で差すやつ ===
    [Header("Containers (World Space Canvas の子)")]
    [Tooltip("テキスト/アラートをスタックするコンテナ。VerticalLayoutGroup 推奨")]
    public RectTransform textContainer;
    [Tooltip("画像/メディアをスタックするコンテナ")]
    public RectTransform mediaContainer;

    [Header("Prefabs")]
    [Tooltip("TextMeshProUGUI を root に持つテキスト 1 行の Prefab")]
    public GameObject textBlockPrefab;
    [Tooltip("RawImage (+ 下に TMP caption) を持つ画像 Prefab")]
    public GameObject imageBlockPrefab;

    [Header("Options")]
    [Tooltip("同時保持する画像枚数上限 (メモリ保護)")]
    public int maxImages = 4;

    // === Bridge payload ===
    [Serializable] private class Request { public string id; public string method; public ShowBlocksArgs args; }
    [Serializable] private class ShowBlocksArgs { public BlockPayload[] blocks; }
    [Serializable]
    private class BlockPayload
    {
        public string type;      // "text" | "image" | "alert" | "timer"
        // text/alert
        public string content;
        public string message;
        public string style;     // normal | emphasis | warning
        public string severity;  // info | warning | danger
        // image
        public string url;
        public string caption;
        // timer
        public string label;
        public int duration_sec;
    }
    [Serializable]
    private class Response
    {
        public string id;
        public string kind;
        public string data;
        public string error;
    }
    [Serializable] private class EmptyData { public bool ok; }

    private readonly List<GameObject> _textInstances = new();
    private readonly List<GameObject> _mediaInstances = new();
    private readonly Dictionary<string, Texture2D> _textureCache = new();

    // === RN -> Unity API ===

    public void ShowBlocks(string json)
    {
        Debug.Log("[RenderBridge] ShowBlocks payload=" + (json ?? "").Length + "B");
        var req = TryParse(json);
        if (req == null) return;
        var blocks = req.args?.blocks ?? Array.Empty<BlockPayload>();

        var texts = new List<BlockPayload>();
        var images = new List<BlockPayload>();
        foreach (var b in blocks)
        {
            if (b == null || string.IsNullOrEmpty(b.type)) continue;
            if (b.type == "text" || b.type == "alert" || b.type == "timer") texts.Add(b);
            else if (b.type == "image") images.Add(b);
        }

        RenderTexts(texts);
        RenderImages(images);
        Reply(req.id, JsonUtility.ToJson(new EmptyData { ok = true }), null);
    }

    public void ClearBlocks(string json)
    {
        Debug.Log("[RenderBridge] ClearBlocks");
        var req = TryParse(json);
        foreach (var go in _textInstances) if (go != null) Destroy(go);
        foreach (var go in _mediaInstances) if (go != null) Destroy(go);
        _textInstances.Clear();
        _mediaInstances.Clear();
        if (req != null) Reply(req.id, JsonUtility.ToJson(new EmptyData { ok = true }), null);
    }

    // === Internal ===

    private void RenderTexts(List<BlockPayload> blocks)
    {
        if (textContainer == null || textBlockPrefab == null)
        {
            Debug.LogWarning("[RenderBridge] textContainer/textBlockPrefab 未設定");
            return;
        }
        EnsurePoolSize(_textInstances, blocks.Count, textBlockPrefab, textContainer);

        for (int i = 0; i < blocks.Count; i++)
        {
            var b = blocks[i];
            var go = _textInstances[i];
            go.SetActive(true);
            var tmp = go.GetComponentInChildren<TMP_Text>();
            if (tmp == null) continue;

            switch (b.type)
            {
                case "text":
                    tmp.text = b.content ?? "";
                    tmp.color = StyleToColor(b.style);
                    break;
                case "alert":
                    tmp.text = "⚠ " + (b.message ?? "");
                    tmp.color = SeverityToColor(b.severity);
                    break;
                case "timer":
                    tmp.text = (b.label ?? "timer") + " " + b.duration_sec + "s";
                    tmp.color = Color.white;
                    break;
            }
        }
        for (int i = blocks.Count; i < _textInstances.Count; i++)
        {
            if (_textInstances[i] != null) _textInstances[i].SetActive(false);
        }
    }

    private void RenderImages(List<BlockPayload> blocks)
    {
        if (mediaContainer == null || imageBlockPrefab == null)
        {
            Debug.LogWarning("[RenderBridge] mediaContainer/imageBlockPrefab 未設定");
            return;
        }
        int n = Mathf.Min(blocks.Count, Mathf.Max(1, maxImages));
        EnsurePoolSize(_mediaInstances, n, imageBlockPrefab, mediaContainer);

        for (int i = 0; i < n; i++)
        {
            var b = blocks[i];
            var go = _mediaInstances[i];
            go.SetActive(true);
            var raw = go.GetComponentInChildren<RawImage>();
            var cap = go.GetComponentInChildren<TMP_Text>();
            if (cap != null) cap.text = b.caption ?? "";
            if (raw != null && !string.IsNullOrEmpty(b.url))
            {
                StartCoroutine(LoadImageInto(raw, b.url));
            }
        }
        for (int i = n; i < _mediaInstances.Count; i++)
        {
            if (_mediaInstances[i] != null) _mediaInstances[i].SetActive(false);
        }
    }

    private IEnumerator LoadImageInto(RawImage target, string url)
    {
        if (_textureCache.TryGetValue(url, out var cached) && cached != null)
        {
            target.texture = cached;
            yield break;
        }

        using var req = UnityWebRequestTexture.GetTexture(url);
        yield return req.SendWebRequest();
        if (req.result != UnityWebRequest.Result.Success)
        {
            Debug.LogWarning("[RenderBridge] image load failed: " + url + " / " + req.error);
            yield break;
        }
        var tex = DownloadHandlerTexture.GetContent(req);
        _textureCache[url] = tex;
        if (target != null) target.texture = tex;
    }

    private static void EnsurePoolSize(List<GameObject> pool, int needed, GameObject prefab, Transform parent)
    {
        while (pool.Count < needed)
        {
            var go = Instantiate(prefab, parent);
            pool.Add(go);
        }
    }

    private static Color StyleToColor(string style) => style switch
    {
        "emphasis" => new Color(0.4f, 0.9f, 1f),
        "warning" => new Color(1f, 0.8f, 0.2f),
        _ => Color.white,
    };
    private static Color SeverityToColor(string severity) => severity switch
    {
        "danger" => new Color(1f, 0.35f, 0.35f),
        "warning" => new Color(1f, 0.8f, 0.2f),
        _ => new Color(0.6f, 0.85f, 1f),
    };

    private static Request TryParse(string json)
    {
        try { return JsonUtility.FromJson<Request>(json); }
        catch (Exception e)
        {
            Debug.LogWarning("[RenderBridge] bad payload: " + e.Message);
            return null;
        }
    }

    private void Reply(string id, string dataJson, string error)
    {
        var res = new Response { id = id, kind = "render", data = dataJson, error = error };
        UnityInterop.SendToRN(JsonUtility.ToJson(res));
    }
}
