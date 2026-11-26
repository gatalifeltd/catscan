// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 GATALIFE LTD

import SwiftUI

struct OnboardingView: View {
    let onNext: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(LocalizedStringKey("onboarding.title"))
                .font(.largeTitle).bold()
            #if FAULTS
            // Planted fault: the raw key leaks onto the screen instead of a translation. It is the body, not the
            // large bold title, because Vision reads a title's "." as a space, which only a catalog run maps back.
            Text(verbatim: "onboarding.body")
                .font(.title3)
            #else
            Text(LocalizedStringKey("onboarding.body"))
                .font(.title3)
            #endif
            Button(action: onNext) {
                Text(LocalizedStringKey("onboarding.next"))
                    .font(.title2)
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("next")
            Spacer()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
