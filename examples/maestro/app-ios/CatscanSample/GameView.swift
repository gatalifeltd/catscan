// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD

import SwiftUI

// Drawn text with no accessibility labels: only OCR can read this screen.
struct GameView: View {
    var body: some View {
        ZStack {
            Canvas { context, size in
                context.fill(
                    Path(CGRect(origin: .zero, size: size)),
                    with: .color(Color(red: 0.05, green: 0.1, blue: 0.35))
                )
                let center = CGPoint(x: size.width / 2, y: size.height * 0.4)
                context.draw(
                    Text(LocalizedStringKey("game.complete"))
                        .font(.system(size: 40, weight: .bold))
                        .foregroundColor(.white),
                    at: center
                )
                context.draw(
                    Text(LocalizedStringKey("game.score"))
                        .font(.system(size: 28))
                        .foregroundColor(.white),
                    at: CGPoint(x: center.x, y: center.y + 64)
                )
            }
            .accessibilityHidden(true)
        }
        .ignoresSafeArea()
        .accessibilityElement()
        .accessibilityIdentifier("game")
    }
}
