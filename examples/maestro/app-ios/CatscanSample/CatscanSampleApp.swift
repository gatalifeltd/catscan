// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD

import SwiftUI

@main
struct CatscanSampleApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

enum Screen {
    case onboarding, settings, game
}

struct RootView: View {
    @State private var screen: Screen = .onboarding

    var body: some View {
        ZStack {
            Color.white.ignoresSafeArea()
            switch screen {
            case .onboarding:
                OnboardingView { screen = .settings }
            case .settings:
                SettingsView { screen = .game }
            case .game:
                GameView()
            }
        }
        .foregroundStyle(.black)
        .preferredColorScheme(.light)
    }
}
