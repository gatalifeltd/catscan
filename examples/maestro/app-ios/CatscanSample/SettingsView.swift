// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD

import SwiftUI

struct SettingsView: View {
    let onPlay: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(LocalizedStringKey("settings.title"))
                .font(.largeTitle).bold()
            Text(LocalizedStringKey("settings.notifications"))
                .font(.body)
                .modifier(NotificationsLabelLayout())
                .accessibilityIdentifier("notifications-label")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 12)
            Button(action: onPlay) {
                Text(LocalizedStringKey("settings.play"))
                    .font(.title2)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("play")
            Spacer()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct NotificationsLabelLayout: ViewModifier {
    func body(content: Content) -> some View {
        #if FAULTS
        // Planted fault: a narrow one-line frame tail-truncates the German label.
        content
            .lineLimit(1)
            .frame(width: 150, alignment: .leading)
        #else
        content
        #endif
    }
}
