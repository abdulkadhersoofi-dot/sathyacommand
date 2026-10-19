// The staff app speaks Tamil or English, chosen on each phone.

const TA: Record<string, string> = {
  'Today': 'இன்று', 'Messages': 'செய்திகள்', 'My attendance': 'என் வருகை', 'Team': 'குழு', 'Rosters': 'பணி அட்டவணை', 'Settings': 'அமைப்புகள்',
  'Clock in': 'பணிக்கு வருகை', 'Clock out': 'பணி முடிவு', 'On duty': 'பணியில்', 'Off duty': 'பணியில் இல்லை',
  'Location on: on duty': 'இருப்பிடம் இயக்கத்தில்: பணி நேரம்', 'Location is shared only while you are on duty.': 'நீங்கள் பணியில் இருக்கும் போது மட்டுமே இருப்பிடம் பகிரப்படும்.',
  'SOS': 'அவசர உதவி', 'Tap, then confirm': 'தட்டி, பின் உறுதிப்படுத்தவும்', 'Help is on the way. Stay where you are if it is safe.': 'உதவி வருகிறது. பாதுகாப்பாக இருந்தால் அங்கேயே இருங்கள்.',
  'Your shift': 'உங்கள் பணி நேரம்', 'No shift on the roster today': 'இன்று அட்டவணையில் பணி இல்லை', 'Late by': 'தாமதம்', 'minutes': 'நிமிடங்கள்',
  'My work': 'என் பணிகள்', 'Nothing waiting for you.': 'உங்களுக்கு எந்த பணியும் இல்லை.', 'Open': 'திற',
  'Location policy': 'இருப்பிடக் கொள்கை', 'I agree': 'ஒப்புக்கொள்கிறேன்',
  'policy': 'பணி நேரத்தில் மட்டும் உங்கள் தொலைபேசியின் இருப்பிடம் சத்யா பார்க் மேலாளர்களுக்குத் தெரியும். பணி முடிந்ததும் அல்லது ரிசார்ட்டுக்கு வெளியே பகிரப்படாது. உங்கள் சொந்த இருப்பிட வரலாற்றை நீங்கள் பார்க்கலாம்; இது 90 நாட்கள் வைக்கப்படும்.',
  'Take a selfie': 'செல்ஃபி எடுக்கவும்', 'Getting your location…': 'உங்கள் இருப்பிடம் கண்டறியப்படுகிறது…', 'Turn on location (GPS) and try again.': 'இருப்பிடத்தை (GPS) இயக்கி மீண்டும் முயற்சிக்கவும்.',
  'Read': 'படித்தேன்', 'Urgent': 'அவசரம்', 'Send a message': 'செய்தி அனுப்பு', 'hours': 'மணி நேரம்', 'Clocked in at': 'வருகை நேரம்',
}

let lang: 'en' | 'ta' = (() => { try { return localStorage.getItem('sathya.lang') === 'ta' ? 'ta' : 'en' } catch { return 'en' } })()

export const t = (s: string) => (lang === 'ta' ? TA[s] ?? s : s === 'policy'
  ? 'While you are on duty, your phone shares its location with Sathya Park managers. Nothing is shared off duty or outside the resort. You can see your own location history; it is kept for 90 days.'
  : s)
export const getLang = () => lang
export function setLang(l: 'en' | 'ta') { lang = l; try { localStorage.setItem('sathya.lang', l) } catch { /* private mode */ } }
