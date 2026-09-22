#!/usr/bin/env python3
"""
Build script for B-PlanDIY.
Converts business-plan-generator.jsx -> app.html (standalone, no build step needed).

Usage:  python3 build.py
"""
import re, sys, os

SRC = "business-plan-generator.jsx"
OUT = "app.html"

here = os.path.dirname(os.path.abspath(__file__))
src_path = os.path.join(here, SRC)
out_path = os.path.join(here, OUT)

with open(src_path, encoding="utf-8", errors="replace") as f:
    app_code = f.read()

# Strip ES imports and the default export keyword
app_code = re.sub(r'^import .*;\n', '', app_code, flags=re.MULTILINE)
app_code = app_code.replace('export default function App(){', 'function App(){')

# --- Logo extraction -------------------------------------------------------
# The JSX holds the logo as:  const LOGO_SRC="data:image/jpeg;base64,<DATA>"
# We move the payload into a separate <script type="text/plain"> block so the
# huge base64 string doesn't bloat the Babel-compiled source.
#
# IMPORTANT: logo_data must be ONLY the data URI. Including the surrounding
# JS (const LOGO_SRC=" ... ") produces an invalid img src and a broken logo.
logo_match = re.search(r'const LOGO_SRC="(data:image/[a-z]+;base64,[^"]+)"', app_code)
if logo_match:
    logo_data = logo_match.group(1)          # <-- data URI only
    app_code = app_code.replace(logo_match.group(0),
                                'const LOGO_SRC=window.__LOGO_SRC__||""')
else:
    logo_data = ''
    print("WARNING: no LOGO_SRC found in source - logo will be blank", file=sys.stderr)

# Sanity check before we write anything
if logo_data and not logo_data.startswith('data:image'):
    sys.exit("ERROR: extracted logo is not a data URI - aborting build")

# --- Access gate -----------------------------------------------------------
# There used to be a full-page "Access Required" screen injected here, which
# returned before App() rendered anything unless bpd_access_expiry held a future
# timestamp. It is gone: the app and the cashflow forecast are free to everyone.
#
# Payment now gates only the AI features - Suggest with AI and Generate Plan.
# That gate is enforced server-side in netlify/functions/anthropic.js, which
# returns 402 without a valid signed token. The app's own check (aiAccess in
# business-plan-generator.jsx) exists purely so the buttons can say so before
# making a pointless round trip; it is not what keeps anyone out.

html = """<!DOCTYPE html>
<html lang="en">
<head>
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=AW-18115223677"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'AW-18115223677');
  // GA4, so funnel events have somewhere to be reported.
  gtag('config', 'G-367W5EDDEB');
</script>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>Free Business Plan &amp; Cashflow Forecast Builder | B-PlanDIY</title>
<!-- The app is free to open and use, so it is a landing page in its own right
     and should be indexed. It used to sit behind a payment wall, where an
     indexed URL would only have shown searchers a locked door. -->
<meta name="robots" content="index,follow"/>
<meta name="description" content="Build a business plan and 12-month cashflow forecast free, in five steps. Pay $29 only if you want the AI to write the plan for you."/>
<link rel="canonical" href="https://b-plandiy.com/app.html"/>
<meta property="og:type" content="website"/>
<meta property="og:url" content="https://b-plandiy.com/app.html"/>
<meta property="og:title" content="Free Business Plan &amp; Cashflow Forecast Builder | B-PlanDIY"/>
<meta property="og:description" content="Build a business plan and 12-month cashflow forecast free, in five steps. Pay $29 only if you want the AI to write the plan for you."/>
<meta property="og:image" content="https://b-plandiy.com/og-image.png"/>
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="Free Business Plan &amp; Cashflow Forecast Builder | B-PlanDIY"/>
<meta name="twitter:description" content="Build a business plan and 12-month cashflow forecast free, in five steps. Pay $29 only if you want the AI to write the plan for you."/>
<meta name="twitter:image" content="https://b-plandiy.com/og-image.png"/>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/favicon-192.png">
<style>
#loading{display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui;color:#01236d;font-size:18px;flex-direction:column;gap:12px;}
.spinner{width:40px;height:40px;border:4px solid #f3f3f3;border-top:4px solid #01236d;border-radius:50%;animation:spin 0.8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}
/* Pulsing dot shown inside a "Suggest with AI" button while it is working */
@keyframes bpdPulse{0%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}100%{opacity:1;transform:scale(1)}}
.bpd-pulse{animation:bpdPulse 1s ease-in-out infinite;}
/* ============================================================
   Interaction polish. Inline styles cannot express :hover or
   :focus, so these add responsiveness without fighting them.
   ============================================================ */

/* Fields react when you are typing in them */
input:not([type=checkbox]):not([type=radio]), select, textarea{
  transition:border-color .15s ease, box-shadow .15s ease, background-color .15s ease;
}
input:not([type=checkbox]):not([type=radio]):hover, select:hover, textarea:hover{
  border-color:#7A93B8 !important;
}
input:not([type=checkbox]):not([type=radio]):focus, select:focus, textarea:focus{
  border-color:#1B4FA8 !important;
  box-shadow:0 0 0 3px rgba(42,157,159,0.20) !important;
  outline:none !important;
}

/* Touch targets. Measured at 28-32px on a phone against a 44px guideline, and
   the month grids were the densest screen in the app at roughly 55x29px per
   cell - the one place twelve months of figures get typed. */
@media (pointer:coarse){
  button, select, input[type=radio], input[type=checkbox]{min-height:44px;}
  input[type=radio], input[type=checkbox]{min-width:24px;}
  /* iOS Safari zooms the whole page in when a field smaller than 16px takes
     focus, and does not zoom back out afterwards. The base input style is
     16px, but seventeen fields override it down to 13 or 15 - the month
     grids, the actual-vs-forecast boxes, the currency picker. Measured in the
     narrow month grid, the densest screen in the app: at 390px a column is
     97px and 16px digits still fit, so this costs nothing but the zoom. */
  input:not([type=radio]):not([type=checkbox]), select, textarea{font-size:16px !important;}
}

/* Buttons lift slightly and deepen on hover */
button{transition:transform .12s ease, box-shadow .15s ease, filter .15s ease, background-color .15s ease;}
button:not(:disabled):hover{transform:translateY(-1px);filter:brightness(1.04);box-shadow:0 3px 10px rgba(1,35,109,0.13);}
button:not(:disabled):active{transform:translateY(0);box-shadow:0 1px 3px rgba(1,35,109,0.12);}
button:disabled{opacity:.55;cursor:not-allowed !important;}
button:focus-visible{outline:2px solid #1B4FA8;outline-offset:2px;}

/* Checkboxes get a pointer and a little feedback */
input[type=checkbox]{transition:transform .12s ease;}
input[type=checkbox]:hover{transform:scale(1.12);}

/* Money and figures line up in columns */
.bpd-num, td, th{font-variant-numeric:tabular-nums;}

/* Panels and dialogs arrive rather than snapping in */
@keyframes bpdFadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes bpdFadeIn{from{opacity:0}to{opacity:1}}
.bpd-appear{animation:bpdFadeUp .22s ease both;}
.bpd-overlay{animation:bpdFadeIn .18s ease both;}

/* A figure that has just changed pulses once, so the eye catches it */
@keyframes bpdNumPop{0%{transform:scale(1)}35%{transform:scale(1.06)}100%{transform:scale(1)}}
.bpd-pop{animation:bpdNumPop .35s ease;display:inline-block;}

/* Softer, warmer page background so white cards read as raised */
body{background:#FCFCFA;}

/* The page itself should never be draggable sideways on a phone.
   Everything in the app that is legitimately wider than a small screen - the
   cashflow table, the step bar, the plan preview - scrolls inside its own
   box, so if the PAGE can be panned then something has escaped its container.
   The usual culprit is an unbroken string with nowhere to wrap: a long email
   address in Main contact, a URL in Online presence, a business name typed
   without spaces, or a long word in an AI suggestion.
   overflow-x:clip rather than hidden, because clip does not turn the body
   into a scroll container and so leaves position:sticky (the live figures
   bar) working. */
html,body{max-width:100%;overflow-x:clip;}
body{overflow-wrap:break-word;}
input,select,textarea{max-width:100%;}

/* Links */
a{transition:color .15s ease;}

/* Scrollbars, where the browser allows styling */
*::-webkit-scrollbar{height:12px;width:12px;}
*::-webkit-scrollbar-thumb{background:#01236D;border-radius:6px;border:3px solid transparent;background-clip:content-box;}
*::-webkit-scrollbar-thumb:hover{background:#02306F;background-clip:content-box;}
*::-webkit-scrollbar-track{background:transparent;}
/* Firefox uses its own properties */
html{scrollbar-color:#01236D transparent;scrollbar-width:thin;}

@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms !important;transition-duration:.01ms !important;}
  button:not(:disabled):hover{transform:none;}
}
/* Consistent 26px rhythm between form rows */
.bpd-field{margin-bottom:26px;}
input:not([type=checkbox]):not([type=radio]):focus, select:focus, textarea:focus{
  border-color:#1B4FA8 !important;
  box-shadow:0 0 0 3px rgba(42,157,159,0.18) !important;
}
select{border-radius:10px !important;padding:13px 12px !important;}
/* Hover explanations for the banner's Save a backup / Clear plan buttons.
   Shown on focus as well as hover, so the keyboard reaches them too. */
.bpd-tip{position:relative;display:inline-flex;}
.bpd-tip-msg{
  /* box-sizing, because the page has no universal border-box reset: width:290
     plus 28px of padding measured 318 and helped push the page past the
     screen edge. */
  box-sizing:border-box;
  position:absolute;top:calc(100% + 10px);right:0;width:290px;max-width:calc(100vw - 24px);
  background:#01236D;color:#fff;font-size:13px;line-height:1.55;font-weight:500;
  padding:12px 14px;border-radius:10px;text-align:left;
  box-shadow:0 10px 28px rgba(1,35,109,0.30);
  opacity:0;visibility:hidden;transform:translateY(-4px);pointer-events:none;z-index:1000;
  transition:opacity .15s ease, transform .15s ease, visibility .15s;
}
.bpd-tip-msg::before{
  content:"";position:absolute;bottom:100%;right:24px;
  border:7px solid transparent;border-bottom-color:#01236D;
}
.bpd-tip:hover .bpd-tip-msg,
.bpd-tip:focus-within .bpd-tip-msg{opacity:1;visibility:visible;transform:translateY(0);}
/* On a phone these were the reason the whole app could be dragged sideways.
   A tooltip is hidden with visibility:hidden, which still takes part in
   layout, and left:0 anchored it to a button sitting well right of centre:
   measured on the live site, the "Clear plan" tooltip reached 515px inside a
   375px screen and the page could be panned by exactly that much. Pinning
   them to the viewport instead of to the button costs the little arrow,
   which is why it is hidden here, and makes them readable rather than
   half off-screen. */
@media(max-width:640px){
  .bpd-tip-msg{position:fixed;left:12px;right:12px;width:auto;max-width:none;}
  .bpd-tip-msg::before{display:none;}
}
</style>
<script src="https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js" onerror="console.warn('docx CDN failed')"></script>
<script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" onerror="console.warn('jszip CDN failed')"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js" onerror="console.warn('xlsx CDN failed')"></script>
</head>
<body>
<div id="loading"><div class="spinner"></div><div>Loading B-PlanDIY...</div></div>
<script>
/* The app boots from ES modules on a CDN. If that host is unreachable - an
   outage, a corporate proxy, a blocklist - the module never executes, so the
   try/catch inside it is never entered and nothing clears this spinner. The
   customer then sits on "Loading" forever with no idea their plan is safe,
   and someone in that state who "reinstalls" by clearing site data destroys
   it. This watchdog says so instead. It is cancelled the moment the app
   mounts. */
window.__bpdBooted = false;
setTimeout(function(){
  if (window.__bpdBooted) return;
  var el = document.getElementById('loading');
  if (!el) return;
  el.innerHTML =
    '<div style="max-width:460px;text-align:center;line-height:1.6">' +
    '<div style="font-size:19px;font-weight:700;color:#01236d;margin-bottom:10px">B-PlanDIY could not load</div>' +
    '<div style="font-size:15px;color:#29384A">The app could not be downloaded, which usually means a network or firewall problem rather than anything wrong with your plan.</div>' +
    '<div style="font-size:15px;color:#29384A;margin-top:10px"><strong>Your plan is still saved on this device.</strong> Do not clear your browsing data. Reload the page in a few minutes and it should come back.</div>' +
    '</div>';
}, 10000);
</script>
<div id="root"></div>
<script id="logo-data" type="text/plain">
""" + logo_data + """
</script>
<script type="module">
import React from 'https://esm.sh/react@18.2.0';
import { createRoot } from 'https://esm.sh/react-dom@18.2.0/client';
import * as Recharts from 'https://esm.sh/recharts@2.10.0?deps=react@18.2.0,react-dom@18.2.0';
import Babel from 'https://esm.sh/@babel/standalone@7.23.2';

window.React = React;
window.Recharts = Recharts;
window.__LOGO_SRC__ = document.getElementById('logo-data').textContent.trim();

const {useState,useRef,useCallback,useEffect} = React;
const {BarChart,Bar,Cell,LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ReferenceLine,ResponsiveContainer} = Recharts;

try {
  const code = document.getElementById('app-src').textContent;
  const compiled = Babel.transform(code, {presets:['react']}).code;
  const fn = new Function(
    'React','useState','useRef','useCallback','useEffect',
    'BarChart','Bar','Cell','LineChart','Line','XAxis','YAxis',
    'CartesianGrid','Tooltip','Legend','ReferenceLine','ResponsiveContainer','Recharts',
    compiled + '\\nreturn App;'
  );
  const App = fn(React,useState,useRef,useCallback,useEffect,BarChart,Bar,Cell,LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ReferenceLine,ResponsiveContainer,Recharts);
  createRoot(document.getElementById('root')).render(React.createElement(App));
  window.__bpdBooted = true;
  document.getElementById('loading').style.display='none';
} catch(e) {
  document.getElementById('loading').innerHTML='<div style="color:red;padding:20px;max-width:600px">Error: '+e.message+'</div>';
  console.error(e);
}
</script>
<script type="text/plain" id="app-src">
""" + app_code + """
</script>
</body>
</html>"""

with open(out_path, 'w', encoding='utf-8') as f:
    f.write(html)

print("Built %s - %d KB" % (OUT, round(len(html) / 1024)))
print("Logo: %s" % ("embedded (%d chars)" % len(logo_data) if logo_data else "MISSING"))
