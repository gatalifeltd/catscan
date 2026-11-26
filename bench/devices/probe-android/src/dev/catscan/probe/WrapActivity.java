// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// TODO-074 rendered positives (bench/wrapping/rendered.mjs): one screen of framework controls whose labels come from
// the extra `wrap` (base64 JSON rows of {kind, id, text, items}), so the same layout renders the en and the pseudo
// strings with Android's own line breaking. Buttons, chips, segments and tabs wrap (no maxLines); the Toolbar title
// stays on one line and ellipsizes, as the framework draws it. Ids come from res/values/ids.xml, which the script
// generates from bench/wrapping/probe-screens.json, so UiAutomator dumps carry a resource-id that pairs en and pseudo.
package dev.catscan.probe;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toolbar;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

public class WrapActivity extends Activity {
    float dp;

    int px(float v) { return Math.round(v * dp); }

    int id(String name) { return getResources().getIdentifier(name, "id", getPackageName()); }

    GradientDrawable shape(int fill, int stroke, float radius) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        if (stroke != 0) g.setStroke(px(1), stroke);
        g.setCornerRadius(px(radius));
        return g;
    }

    TextView label(JSONObject it, float sp) {
        TextView t = new TextView(this);
        t.setText(it.optString("text"));
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(Color.BLACK);
        t.setId(id(it.optString("id")));
        return t;
    }

    View make(JSONObject it) throws Exception {
        String kind = it.getString("kind");
        switch (kind) {
            case "button": {
                Button b = new Button(this);
                b.setAllCaps(false);
                b.setText(it.optString("text"));
                b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
                b.setId(id(it.optString("id")));
                return b;
            }
            case "chip": {
                TextView t = label(it, 15);
                t.setGravity(Gravity.CENTER);
                t.setPadding(px(12), px(6), px(12), px(6));
                t.setBackground(shape(0xFFDCE7FF, 0, 16));
                t.setClickable(true);
                return t;
            }
            case "segment": {
                RadioGroup g = new RadioGroup(this);
                g.setOrientation(LinearLayout.HORIZONTAL);
                g.setId(id(it.optString("id")));
                JSONArray items = it.getJSONArray("items");
                for (int i = 0; i < items.length(); i++) {
                    JSONObject s = items.getJSONObject(i);
                    RadioButton r = new RadioButton(this);
                    r.setButtonDrawable(null);
                    r.setText(s.optString("text"));
                    r.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
                    r.setTextColor(Color.BLACK);
                    r.setGravity(Gravity.CENTER);
                    r.setPadding(px(6), px(8), px(6), px(8));
                    r.setBackground(shape(i == 0 ? 0xFFDCE7FF : Color.WHITE, 0xFF8090B0, 8));
                    r.setId(id(s.optString("id")));
                    g.addView(r, new RadioGroup.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                    if (i == 0) g.check(r.getId());
                }
                return g;
            }
            case "title": {
                TextView t = label(it, 28);
                t.setTypeface(Typeface.DEFAULT_BOLD);
                return t;
            }
            default: { // subtitle
                TextView t = label(it, 16);
                t.setTextColor(0xFF555555);
                return t;
            }
        }
    }

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        dp = getResources().getDisplayMetrics().density;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.WHITE);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(px(12), px(8), px(12), px(8));
        View tabs = null;
        try {
            JSONArray rows = new JSONArray(new String(Base64.decode(getIntent().getStringExtra("wrap"), Base64.DEFAULT), StandardCharsets.UTF_8));
            for (int r = 0; r < rows.length(); r++) {
                JSONArray row = rows.getJSONArray(r);
                JSONObject first = row.getJSONObject(0);
                if ("nav".equals(first.getString("kind"))) {
                    Toolbar tb = new Toolbar(this);
                    tb.setTitle(first.optString("text"));
                    tb.setNavigationIcon(android.R.drawable.ic_menu_close_clear_cancel);
                    tb.setId(id(first.optString("id")));
                    root.addView(tb, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                    continue;
                }
                if ("tabs".equals(first.getString("kind"))) {
                    LinearLayout bar = new LinearLayout(this);
                    bar.setOrientation(LinearLayout.HORIZONTAL);
                    bar.setBaselineAligned(false);
                    bar.setBackgroundColor(0xFFF2F4F8);
                    bar.setId(id(first.optString("id")));
                    JSONArray items = first.getJSONArray("items");
                    for (int i = 0; i < items.length(); i++) {
                        TextView t = label(items.getJSONObject(i), 12);
                        t.setGravity(Gravity.CENTER);
                        t.setPadding(px(4), px(10), px(4), px(10));
                        t.setClickable(true);
                        if (i == 0) t.setTextColor(0xFF1A5FD0);
                        bar.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                    }
                    tabs = bar;
                    continue;
                }
                LinearLayout line = new LinearLayout(this);
                line.setOrientation(LinearLayout.HORIZONTAL);
                line.setBaselineAligned(false);
                for (int i = 0; i < row.length(); i++) {
                    LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1);
                    lp.setMargins(px(4), px(4), px(4), px(4));
                    line.addView(make(row.getJSONObject(i)), lp);
                }
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
                lp.setMargins(0, 0, 0, px(8));
                content.addView(line, lp);
            }
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        if (tabs != null) root.addView(tabs, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        // Edge to edge (target SDK 35+): keep the controls clear of the status bar and the gesture handle.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets s = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(s.left, s.top, s.right, s.bottom);
            return insets;
        });
        setContentView(root);
    }
}
