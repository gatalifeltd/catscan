// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD
// Probe app for bench/devices/android-profiles.mjs (TODO-073 D2, D28): a white edge-to-edge screen that logs what
// Android gives every app about its display: the cutout path, the rounded corners and the gesture insets, as hidden
// pixel runs in the current orientation. The extra `orientation` (portrait, landscape-left, landscape-right) turns it.
package dev.catscan.probe;

import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Path;
import android.graphics.Rect;
import android.graphics.Region;
import android.graphics.RegionIterator;
import android.os.Bundle;
import android.util.Log;
import android.view.DisplayCutout;
import android.view.RoundedCorner;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;

public class ProbeActivity extends Activity {
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        String o = getIntent().getStringExtra("orientation");
        // Android names rotations by the screen: landscape-left (the device's top on the left) is ROTATION_90, which
        // the activity asks for as plain landscape; landscape-right is reverse landscape.
        setRequestedOrientation("landscape-left".equals(o) ? ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            : "landscape-right".equals(o) ? ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        getWindow().getAttributes().layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
        getWindow().setDecorFitsSystemWindows(false);
        getWindow().setStatusBarColor(Color.TRANSPARENT);
        getWindow().setNavigationBarColor(Color.TRANSPARENT);
        View v = new View(this);
        v.setBackgroundColor(Color.WHITE);
        v.setOnApplyWindowInsetsListener((view, insets) -> { report(insets); return insets; });
        setContentView(v);
        // The status bar text would read as ink; hide it, keep the navigation (gesture handle) visible.
        getWindow().getInsetsController().hide(WindowInsets.Type.statusBars());
    }

    static String runs(Region r) {
        StringBuilder sb = new StringBuilder();
        RegionIterator it = new RegionIterator(r);
        Rect rc = new Rect();
        while (it.next(rc)) for (int y = rc.top; y < rc.bottom; y++) sb.append(sb.length() == 0 ? "" : ",").append("[").append(y).append(",").append(rc.left).append(",").append(rc.right).append("]");
        return "[" + sb + "]";
    }

    void report(WindowInsets insets) {
        Rect bounds = getWindowManager().getCurrentWindowMetrics().getBounds();
        int w = bounds.width(), h = bounds.height();
        Region clip = new Region(0, 0, w, h);
        String cutout = "[]";
        DisplayCutout dc = insets.getDisplayCutout();
        if (dc != null && dc.getCutoutPath() != null) { Region r = new Region(); r.setPath(dc.getCutoutPath(), clip); cutout = runs(r); }
        // A rounded corner hides what lies outside its arc inside the corner's square.
        Region corners = new Region();
        int[] pos = { RoundedCorner.POSITION_TOP_LEFT, RoundedCorner.POSITION_TOP_RIGHT, RoundedCorner.POSITION_BOTTOM_LEFT, RoundedCorner.POSITION_BOTTOM_RIGHT };
        for (int p : pos) {
            RoundedCorner c = insets.getRoundedCorner(p);
            if (c == null || c.getRadius() == 0) continue;
            int rad = c.getRadius(), cx = c.getCenter().x, cy = c.getCenter().y;
            int x0 = cx < w / 2 ? cx - rad : cx, y0 = cy < h / 2 ? cy - rad : cy;
            Path sq = new Path();
            sq.addRect(x0, y0, x0 + rad, y0 + rad, Path.Direction.CW);
            Path circle = new Path();
            circle.addCircle(cx, cy, rad, Path.Direction.CW);
            sq.op(circle, Path.Op.DIFFERENCE);
            Region r = new Region();
            r.setPath(sq, clip);
            corners.op(r, Region.Op.UNION);
        }
        Insets g = insets.getInsets(WindowInsets.Type.mandatorySystemGestures());
        Insets nav = insets.getInsets(WindowInsets.Type.navigationBars());
        String json = "{\"width\":" + w + ",\"height\":" + h + ",\"density\":" + getResources().getDisplayMetrics().density
            + ",\"cutout\":" + cutout + ",\"corner\":" + runs(corners)
            + ",\"gestures\":[" + g.left + "," + g.top + "," + g.right + "," + g.bottom + "],\"navigation\":[" + nav.left + "," + nav.top + "," + nav.right + "," + nav.bottom + "]}";
        // logcat cuts a line at about 4 KB and the runs are longer: "<report id> <part> <parts> <chunk>" lines.
        long id = System.nanoTime();
        int n = (json.length() + 2999) / 3000;
        for (int i = 0; i < n; i++) Log.i("catscan-probe", id + " " + i + " " + n + " " + json.substring(i * 3000, Math.min(json.length(), (i + 1) * 3000)));
    }
}
