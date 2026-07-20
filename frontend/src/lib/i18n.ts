// Minimal i18next bootstrap for the ported dialog.tsx / button.tsx components.
//
// Only react, react-dom, and @tanstack/react-query are shared via the host's
// module-federation share scope (see apps/web/src/lib/plugins/loader.tsx) —
// react-i18next is NOT shared, so this plugin's bundled copy runs against its
// own i18next instance rather than the host's. Without initializing it,
// useTranslation("common") would warn and fall back to raw key strings
// (e.g. the dialog close button's sr-only label rendering literally as
// "dialog.closeLabel"). Initialize inline with just the two keys dialog.tsx
// actually uses, mirroring apps/web/src/i18n/locales/en/common.json exactly.
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

if (!i18next.isInitialized) {
	i18next.use(initReactI18next).init({
		lng: "en",
		fallbackLng: "en",
		resources: {
			en: {
				common: {
					dialog: {
						closeLabel: "Close",
						closeButton: "Close",
					},
				},
			},
		},
		interpolation: { escapeValue: false },
	});
}

export default i18next;
