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

# --- Access gate injected at the top of App() ------------------------------
access_check = """
  var ACCESS_KEY='bpd_access_expiry';
  try{
    var expiry=localStorage.getItem(ACCESS_KEY);
    if(!expiry||Date.now()>parseInt(expiry)){
      return React.createElement('div',{style:{display:'flex',alignItems:'center',justifyContent:'center',height:'100vh',fontFamily:'system-ui',flexDirection:'column',gap:16,padding:24,textAlign:'center'}},
        React.createElement('div',{style:{fontSize:22,fontWeight:700,color:'#01236d',marginBottom:8}},'Access Required'),
        React.createElement('div',{style:{fontSize:15,color:'#6b7280',maxWidth:400,marginBottom:24}},expiry?'Your 3-month access has expired.':'No active subscription found.'),
        React.createElement('a',{href:'https://buy.stripe.com/7sY5kE6Jo1vP0s9cxcabK00',style:{background:'#d0b16f',color:'white',padding:'14px 32px',borderRadius:8,fontWeight:700,fontSize:16,textDecoration:'none'}},'Get started for $29'),
        React.createElement('div',{style:{marginTop:16,fontSize:14,color:'#6b7280'}},'Already paid? ',React.createElement('a',{href:'/verify.html',style:{color:'#01236d',fontWeight:600,textDecoration:'underline'}},'Verify your email to restore access'))
      );
    }
  }catch(e){}
"""
app_code = app_code.replace('function App(){\n', 'function App(){\n' + access_check)

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
</script>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>B-PlanDIY - Business Plan Generator</title>
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
</style>
<script src="https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js" onerror="console.warn('docx CDN failed')"></script>
<script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" onerror="console.warn('jszip CDN failed')"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js" onerror="console.warn('xlsx CDN failed')"></script>
</head>
<body>
<div id="loading"><div class="spinner"></div><div>Loading B-PlanDIY...</div></div>
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

const {useState,useRef,useCallback} = React;
const {BarChart,Bar,Cell,LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ReferenceLine,ResponsiveContainer} = Recharts;

try {
  const code = document.getElementById('app-src').textContent;
  const compiled = Babel.transform(code, {presets:['react']}).code;
  const fn = new Function(
    'React','useState','useRef','useCallback',
    'BarChart','Bar','Cell','LineChart','Line','XAxis','YAxis',
    'CartesianGrid','Tooltip','Legend','ReferenceLine','ResponsiveContainer','Recharts',
    compiled + '\\nreturn App;'
  );
  const App = fn(React,useState,useRef,useCallback,BarChart,Bar,Cell,LineChart,Line,XAxis,YAxis,CartesianGrid,Tooltip,Legend,ReferenceLine,ResponsiveContainer,Recharts);
  createRoot(document.getElementById('root')).render(React.createElement(App));
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
