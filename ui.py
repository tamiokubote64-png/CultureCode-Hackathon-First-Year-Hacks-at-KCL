"""Sonic Postcodes: Streamlit UI with FastAPI visual-analysis integration.

Run from the repository root: python -m streamlit run ui.py
Run the backend separately from backend/: python -m uvicorn app.main:app --reload --port 8000
The original Echoframe environment explorer remains available as an optional mode.
"""
import base64, colorsys, hashlib, io, json, os, zlib

import numpy as np
import streamlit as st
from PIL import Image, ImageDraw, ImageFont, ImageOps
from ui_backend_client import BackendError, SCORE_NAMES, analyze_with_backend

MODEL = "claude-sonnet-5-5"   # change if your account uses another model
ENVS = ["City street", "Town or village", "Countryside", "Farmland", "Forest", "Mountains", "Coast or beach",
        "Lake or river", "Desert", "Snowy landscape", "Park or garden", "Indoors", "Other"]


def load(b):
    return ImageOps.exif_transpose(Image.open(io.BytesIO(b))).convert("RGB")


# ------------------------------------------------------------ 1. Claude vision (primary)
PROMPT = """You are identifying the environment shown in a photo. Look carefully at what is actually visible. Do not assume people, cars or crowds unless you can see them.
Return JSON only, no prose: {{"environment": one of {envs}, "time": "Daytime" or "Sunrise or sunset" or "Night", "weather": "a short phrase, or empty", "reason": "one sentence on what you can see that decided it", "features": [{{"label": "short name such as Church, Sheep, Hedgerow, Harbour", "x": 0 to 1, "y": 0 to 1}}]}}
Give 3 to 8 features, only things you can see. x runs left to right and y top to bottom, measured at the centre of each thing."""


def analyze_ai(img, api_key):
    import anthropic
    im = img.copy(); im.thumbnail((1024, 1024))
    buf = io.BytesIO(); im.save(buf, "JPEG", quality=85)
    msg = anthropic.Anthropic(api_key=api_key).messages.create(
        model=MODEL, max_tokens=800,
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.b64encode(buf.getvalue()).decode()}},
            {"type": "text", "text": PROMPT.format(envs=json.dumps(ENVS))}]}])
    t = msg.content[0].text
    r = json.loads(t[t.index("{"): t.rindex("}") + 1])
    feats = [dict(label=str(x["label"])[:40], x=float(np.clip(x["x"], 0, 1)), y=float(np.clip(x["y"], 0, 1)), pct=0)
             for x in r.get("features", [])[:8] if x.get("label")]
    return dict(env=str(r["environment"]), why=str(r.get("reason", "")), time=str(r.get("time", "")),
                weather=str(r.get("weather", "")), feats=feats, src="ai")


# ------------------------------------------------------------ 2. On-device estimate (fallback)
def analyze_colors(img):
    w, h = 64, 40
    a = np.asarray(img.resize((w, h)), dtype=np.float32) / 255
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx, mn = a.max(-1), a.min(-1)
    l, d = (mx + mn) / 2, mx - mn
    s = np.where(d > 0, d / (1 - np.abs(2 * l - 1) + 1e-6), 0)
    dd = np.where(d > 0, d, 1)
    hu = np.where(d > 0, np.where(mx == r, ((g - b) / dd) % 6, np.where(mx == g, (b - r) / dd + 2, (r - g) / dd + 4)) * 60, 0)
    yy = np.repeat((np.arange(h) / h)[:, None], w, 1)
    yc = np.repeat(((np.arange(h) + .5) / h)[:, None], w, 1)
    xs = np.repeat(((np.arange(w) + .5) / w)[None, :], h, 0)
    E = np.zeros((h, w), np.float32)                                    # local edge strength
    E[:, :-1] += np.abs(l[:, :-1] - l[:, 1:]); E[:-1, :] += np.abs(l[:-1, :] - l[1:, :])
    avg = float(l.mean()); night = avg < .3
    free = np.ones((h, w), bool)

    def take(m):
        nonlocal free
        m = m & free; free = free & ~m
        return m

    take(l < .12)
    blue = take((hu >= 185) & (hu <= 255) & (s > .15) & (l > .3))
    sky = blue & ((yy < .5) | (l > .8)); water = blue & ~sky
    green = take((hu >= 55) & (hu <= 170) & (s > .12))
    lights = take((s > .5) & (l > .45) & ((hu < 65) | (hu >= 300)) & night)
    warm = take((yy < .5) & (E < .05) & (s > .3) & (l > .35) & ((hu < 50) | (hu >= 290)))
    sky = sky | warm
    earth = take((hu >= 25) & (hu <= 70) & (s > .15) & (s < .6) & (l > .25) & (l < .88) & (yy > .3))
    snow = take((l > .82) & (s < .15) & (yy >= .3))
    grey = take((yy < .4) & (s < .12) & (l > .3) & (l <= .8))
    sky = sky | take((yy < .3) & (s < .2) & (l > .7))
    structure = take((s < .25) & (l < .85))
    tex = structure & (E > .05)
    glow = take((yy >= .4) & (E < .05))
    sd = structure.copy()                                               # structure plus a 1-cell border
    sd[1:] |= structure[:-1]; sd[:-1] |= structure[1:]; sd[:, 1:] |= structure[:, :-1]; sd[:, :-1] |= structure[:, 1:]
    bs = sd & (E > .16)                                                 # busy detail in and around buildings
    rows = np.where((glow.mean(1) > .6) & (yy[:, 0] >= .4))[0]
    if len(rows) >= 6 and bs.mean() < .08:                              # wide smooth colourful band = lit water
        water = water | (glow & np.isin(np.arange(h), rows)[:, None])

    f = lambda m: float(m.sum()) / (w * h)
    veg, st_, bs_, wt, tx, sk = f(green) + f(earth), f(structure), f(bs), f(water), f(tex), f(sky)
    city = st_ > .25 and bs_ > .08 and veg < .2 and st_ > wt            # never a city if greenery is plentiful
    if f(snow) > .2: env, why = "Snowy landscape", "Large bright, white areas cover the lower part of the frame."
    elif city: env, why = "City street", "Dense, detailed buildings fill the frame, with little greenery or water."
    elif wt > .06 and f(green) > .1: env, why = "Lake or river", "Water sits next to greenery."
    elif wt > .06: env, why = "Coast", "A wide band of water sits under the sky, with little greenery."
    elif f(earth) > .2 and f(green) < .1: env, why = "Dry open land", "Mostly sandy or golden ground. It could be desert or dry farmland."
    elif veg > .35 and sk > .15: env, why = "Countryside", "Greenery and open ground fill most of the frame, with sky above."
    elif veg > .35: env, why = "Forest or woodland", "Greenery fills most of the frame, with little sky."
    elif veg > .12 and .04 < st_ < .22: env, why = "Village or farmland", "Greenery with a few buildings."
    elif veg > .12: env, why = "Countryside", "Greenery and open ground, with few or no buildings."
    elif tx > .15 and bs_ < .04: env, why = "Mountains or rocky ground", "Large areas of textured rock or hills, with few buildings."
    elif st_ > .15: env, why = "Town or built-up area", "Buildings take up a good part of the frame."
    else: env, why = "Open landscape", "No single feature dominates the frame."

    feats = []
    def ft(label, m, lo):
        if f(m) > lo:
            feats.append(dict(label=label, x=float(xs[m].mean()), y=float(yc[m].mean()), pct=round(f(m) * 100)))
    ft("Sky", sky, .06); ft("Water", water, .06); ft("Trees and grass", green, .05); ft("Fields and open ground", earth, .1)
    ft("Snow", snow, .1); ft("Overcast cloud", grey, .15)
    if night: ft("Lights", lights, .01)
    if env.startswith("Mountains"): ft("Rock and hills", tex, .1)
    elif st_ > .04: ft("Buildings", structure, .04)
    return dict(env=env, why=why, feats=feats, src="device",
                time="Sunrise or sunset" if f(warm) > .1 else "Night" if night else "Daytime",
                weather="overcast" if f(grey) > .2 else "snow on the ground" if f(snow) > .2 else "")


@st.cache_data(show_spinner="Looking at your photo…")
def get_result(b, api_key):
    img = load(b); est = analyze_colors(img)
    if not api_key: return est
    try: return analyze_ai(img, api_key)
    except Exception as e:
        est["warn"] = f"Claude analysis failed ({e}). Showing the on-device estimate instead."
        return est


# ------------------------------------------------------------ 3. samples and marker overlay
def sample(kind):
    rng = np.random.default_rng(3); W, H = 800, 500
    top, bot = ((110, 168, 232), (246, 201, 160)) if kind == "city" else ((110, 168, 232), (207, 230, 247))
    t = np.clip(np.linspace(0, 1 / .7 if kind == "city" else 1, H), 0, 1)[:, None, None]
    img = Image.fromarray(np.repeat((np.array(top) * (1 - t) + np.array(bot) * t).astype(np.uint8), W, 1))
    d = ImageDraw.Draw(img)
    rgb = lambda h_, l_, s_: tuple(int(c * 255) for c in colorsys.hls_to_rgb(h_ / 360, l_, s_))
    if kind == "city":
        for i in range(14):
            bw, bh, px = rng.uniform(40, 100), rng.uniform(120, 370), i * 58
            d.rectangle([px, H - bh, px + bw, H], fill=rgb(220, rng.uniform(.35, .55), rng.uniform(.08, .18)))
            for a in range(int(px + 8), int(px + bw - 8), 14):
                for b in range(int(H - bh + 10), 490, 18):
                    if rng.random() < .35: d.rectangle([a, b, a + 6, b + 9], fill=(255, 215, 122))
        d.rectangle([0, 455, W, H], fill=(58, 63, 77))
    elif kind == "coast":
        d.rectangle([0, 230, W, 380], fill=(43, 143, 196)); d.rectangle([0, 380, W, H], fill=(217, 197, 154))
    else:
        for i in range(3):
            pts = [(0, H)] + [(a, 220 + i * 50 + 30 * np.sin(a / 90 + i)) for a in range(0, W + 1, 40)] + [(W, H)]
            d.polygon(pts, fill=rgb(105, .48 - .08 * i, .4 + .05 * i))
    buf = io.BytesIO(); img.save(buf, "PNG"); return buf.getvalue()


def draw_pins(img, feats):
    im = img.copy(); im.thumbnail((1000, 1000)); W, H = im.size
    d = ImageDraw.Draw(im, "RGBA")
    try: font = ImageFont.load_default(size=max(12, W // 55))
    except TypeError: font = ImageFont.load_default()
    for x in feats:
        cx, cy = x["x"] * W, x["y"] * H
        d.ellipse([cx - 8, cy - 8, cx + 8, cy + 8], fill=(217, 54, 116, 255), outline=(255, 255, 255, 255), width=2)
        bb = d.textbbox((0, 0), x["label"], font=font); tw, th = bb[2] - bb[0], bb[3] - bb[1]
        d.rounded_rectangle([cx - tw / 2 - 7, cy + 13, cx + tw / 2 + 7, cy + 13 + th + 10], 8, fill=(15, 16, 48, 215))
        d.text((cx - tw / 2, cy + 16 - bb[1]), x["label"], font=font, fill=(255, 255, 255, 255))
    return im


# ------------------------------------------------------------ 4. the app
st.set_page_config(page_title="Sonic Postcodes", page_icon="🎧", layout="wide")
st.title("Sonic Postcodes")
st.write("Upload a photograph to translate its visible atmosphere into musical parameters.")

with st.sidebar:
    mode = st.radio(
        "View",
        ("Sonic Postcodes (FastAPI)", "Environment explorer (legacy)"),
        help="Sonic Postcodes uses the shared Python backend. The legacy explorer has a separate analysis.",
    )
    api_url = os.environ.get("SONIC_API_URL", "http://127.0.0.1:8000").rstrip("/")
    st.caption(f"Vision backend: {api_url}")
    if mode == "Environment explorer (legacy)":
        key = os.environ.get("ANTHROPIC_API_KEY", "") or st.text_input(
            "Anthropic API key",
            type="password",
            help="Optional key for the original explorer. Without one, the explorer uses a rough colour-based estimate.",
        )

up = st.file_uploader("Choose a photograph", type=["png", "jpg", "jpeg", "webp"])
if up is not None:
    uploaded_bytes = up.getvalue()
    fingerprint = hashlib.sha256(uploaded_bytes).hexdigest()
    if st.session_state.get("upload_fingerprint") != fingerprint:
        st.session_state.img = uploaded_bytes
        st.session_state.image_filename = up.name
        st.session_state.upload_fingerprint = fingerprint

sample_cols = st.columns(3)
for col, (label, kind) in zip(sample_cols, [
    ("Sample city", "city"),
    ("Sample countryside", "country"),
    ("Sample coast", "coast"),
]):
    if col.button(label, use_container_width=True):
        st.session_state.img = sample(kind)
        st.session_state.image_filename = f"sample-{kind}.png"

if "img" not in st.session_state:
    st.info("Upload a photograph or choose a sample image to begin.")
    st.stop()

image_bytes = st.session_state.img
image_filename = st.session_state.get("image_filename", "photograph.png")

if mode == "Sonic Postcodes (FastAPI)":
    left, right = st.columns([3, 2], gap="large")
    with left:
        st.image(load(image_bytes), use_container_width=True)
    with right:
        st.subheader("AI visual interpretation")
        st.caption("Scores and explanations are generated by your FastAPI backend, not by this Streamlit file.")
        if st.button("Analyse photograph", type="primary", use_container_width=True):
            try:
                with st.spinner("Asking your vision backend to analyse the photograph…"):
                    result = analyze_with_backend(image_bytes, image_filename, api_url)
                st.session_state.sonic_result = {
                    "image_hash": hashlib.sha256(image_bytes).hexdigest(),
                    "api_url": api_url,
                    "data": result,
                }
            except BackendError as exc:
                st.session_state.pop("sonic_result", None)
                st.error(str(exc))

        saved = st.session_state.get("sonic_result")
        matching_image = (
            saved is not None
            and saved.get("image_hash") == hashlib.sha256(image_bytes).hexdigest()
            and saved.get("api_url") == api_url
        )
        if matching_image:
            analysis = saved["data"]
            st.header(analysis["scene"])
            st.write(analysis["description"])
            for name in SCORE_NAMES:
                score = float(analysis["scores"][name])
                st.progress(score, text=f"{name.title()}: {score:.2f}")
                st.caption(analysis["explanations"][name])
            with st.expander("Raw VisualAnalysis JSON (for music integration)"):
                st.json(analysis)
            st.download_button(
                "Download analysis as JSON",
                data=json.dumps(analysis, indent=2),
                file_name="sonic-postcodes-analysis.json",
                mime="application/json",
            )
            st.info("The music-generation stream can use these five scores. Audio playback is not connected here yet.")
        elif "sonic_result" not in st.session_state:
            st.info("Click 'Analyse photograph' to send the image to POST /api/analyze.")
        else:
            st.info("Click 'Analyse photograph' to analyse the newly selected picture.")

else:
    # Preserve the teammate's original Echoframe feature-explorer as a separate mode.
    res = get_result(image_bytes, key)
    if res.get("warn"):
        st.warning(res["warn"])
    left, right = st.columns([3, 2], gap="large")
    with left:
        st.image(draw_pins(load(image_bytes), res["feats"]), use_container_width=True)
    with right:
        st.caption("Identified by Claude" if res["src"] == "ai" else "On-device colour/shape estimate")
        st.header(res["env"])
        st.write(res["why"])
        meta = ", ".join(x for x in [res["time"], res["weather"]] if x)
        if meta:
            st.caption(meta)
        st.subheader("What it found")
        for feature in res["feats"]:
            where = ("left" if feature["x"] < .34 else
                     "right" if feature["x"] > .66 else "centre")
            coverage = f", {feature['pct']}% of the frame" if feature["pct"] else ""
            st.markdown(f"**{feature['label']}**  \n{where}{coverage}")
        if res["src"] != "ai":
            st.caption("This is a rough local image heuristic, not live AI analysis.")
