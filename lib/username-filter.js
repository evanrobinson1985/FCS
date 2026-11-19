// Keeps profanity, slurs and gruesome words out of usernames.
//
// Usernames may only hold letters, digits, ".", "_" and "-", so the checks
// work on two views of a name:
//  - squashed: lower case, common look-alike digits/symbols read as letters
//    (0->o, 1->i, 3->e, 4->a, 5->s, 7->t, @->a, $->s), everything that isn't
//    a letter dropped, and runs of a repeated letter shortened, so
//    "F_u_u_c_k", "sh1t" and "N1gg3r" are all caught;
//  - words: the name split at separators, digits and camelCase capitals
//    ("BigRapeGuy" -> big, rape, guy), for short words that are only bad on
//    their own ("ass", "cum", "gore") and would otherwise also match
//    "assassin", "cucumber" or "Gorecki".
// A few real words and names that contain a bad word by accident
// ("Scunthorpe", "therapist", "fire retardant") are allowed through.

const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", 9: "g", "@": "a", $: "s", "!": "i", "|": "i" };

// Bad anywhere in a name
const ANYWHERE = [
  // profanity and sexual terms
  "fuck", "fuk", "fck", "fvck", "phuck", "shit", "sht", "cunt", "kunt", "bitch", "biatch", "bastard", "whore", "slut",
  "dildo", "blowjob", "blowme", "suckmy", "suckit", "handjob", "rimjob", "jizz", "cocksuck", "dicksuck", "dickhead",
  "asshole", "arsehole", "asswipe", "dumbass", "jackass", "asshat", "assclown", "assface", "asslick", "assmunch",
  "bigdick", "mydick", "suckdick", "bigcock", "mycock", "bonglord", "bonghit", "blazeit", "penis", "vagina", "pussy", "porn", "boner", "twat", "wank",
  "motherf", "milf", "hentai", "orgasm", "ejaculat", "masturbat", "testicle", "scrotum", "butthole", "titties",
  "boobs", "horny", "nudes", "sexy",
  // slurs and hate
  "nigger", "nigga", "niger", "faggot", "fagot", "retard", "spastic", "tranny", "chink", "kike", "wetback", "beaner",
  "raghead", "towelhead", "gook", "coon", "hitler", "nazi", "heilhitler", "siegheil", "kkk", "whitepower",
  // gruesome / violent
  "rapist", "rapeme", "pedophil", "paedophil", "molest", "necrophil", "bestiality", "murder", "slaughter", "massacre",
  "genocide", "behead", "decapitat", "dismember", "mutilat", "disembowel", "eviscerat", "corpse", "cadaver",
  "deadbaby", "deadbabies", "deadbody", "suicide", "killyourself", "killurself", "killself", "killer", "killall",
  "killthe", "killem", "torture", "bloodbath", "bloodlust", "carnage", "bloodygore", "guts", "entrails", "massgrave",
  "serialkill", "schoolshoot", "massshoot", "terrorist", "suicidebomb", "isis",
];

// Bad only as a whole word of the name
const WHOLE_WORD = new Set([
  "ass", "arse", "cum", "sex", "gore", "rape", "raped", "rapes", "kill", "kills", "die", "dead", "tit", "tits",
  "cock", "kkk", "anus", "fag", "fags", "homo", "hoe", "hoes", "kys", "wtf", "stfu", "gfy", "anal", "nut", "nuts", "semen",
  "spic", "jap", "skank", "thot", "pimp", "crap", "piss", "poop", "butt", "bong", "weed", "meth", "crack", "nsfw",
  "blood", "bloody", "gory", "slay", "stab", "shoot", "lynch", "hang",
]);

// Real words and names that contain a bad word by accident
const ALLOWED = [
  "scunthorpe", "penistone", "therapist", "therapists", "retardant", "nazir", "nazira", "shiitake", "shitake",
  "cockburn", "hancock", "dickens", "dickson", "dickinson", "sussex", "essex", "middlesex", "assassin",
  "classic", "bass", "grass", "glass", "class", "pass", "mass", "brass", "cassie", "cassidy", "lassiter",
  "cocktail", "peacock", "shuttlecock", "babcock", "hitchcock", "woodcock", "cockrell", "cockerel",
  "matsushita", "kuntz", "shitzu", "shitsu", "pussycat", "pussywillow", "coonhound", "raccoon", "tycoon", "cocoon", "coonley", "racoon",
  "niger", "nigeria", "nigerian", "snigger", "analyst", "analysis", "canal", "anaheim", "hanover",
  "buttercup", "butterfly", "butters", "butterworth", "butthead", "scuttle", "gutsy",
  "isisford", "pumpkin", "hoedown", "shoehorn", "spicer", "japan", "japanese", "nutmeg", "nuthatch",
  "skillet", "skills", "skillful", "killarney", "killian", "kilkenny", "bomberger",
];

function readLeet(text) {
  return String(text)
    .toLowerCase()
    .split("")
    .map((c) => (LEET[c] !== undefined ? LEET[c] : c))
    .join("");
}

function squash(text) {
  return readLeet(text).replace(/[^a-z]/g, "").replace(/(.)\1+/g, "$1");
}

function words(text) {
  // Split camelCase before lower-casing, then at anything that isn't a letter
  return String(text)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9@$!|]+|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/)
    .map((w) => readLeet(w).replace(/[^a-z]/g, ""))
    .filter(Boolean);
}

// True if the username (or name) contains profanity, a slur or a
// gruesome word. Never says which, so the message can't teach workarounds.
function isOffensiveName(name) {
  if (typeof name !== "string" || !name) return false;
  let squashed = squash(name);
  for (const ok of ALLOWED) squashed = squashed.split(squash(ok)).join("_");
  // Also check with doubled letters kept (e.g. "assassin" vs "asasin")
  let plain = readLeet(name).replace(/[^a-z]/g, "");
  for (const ok of ALLOWED) plain = plain.split(ok).join("_");
  for (const bad of ANYWHERE) {
    if (plain.includes(bad)) return true;
    // The repeated-letter-proof check, only where shrinking repeats still
    // leaves a distinctive word ("kkk" -> "k" would match everything)
    const b = squash(bad);
    if (b.length >= 4 && squashed.includes(b)) return true;
  }
  // Troll numbers
  if (/42069|69420/.test(String(name))) return true;
  return words(name).some((w) => WHOLE_WORD.has(w) || WHOLE_WORD.has(w.replace(/(.)\1+/g, "$1")));
}

const OFFENSIVE_NAME_MESSAGE =
  "That username isn't allowed. Please choose one without profanity, slurs or graphic violence.";

// ---- Legal first and last names --------------------------------------------
// Real surnames include words that are only bad on their own (Gore, Butts,
// Cock, Blood, Dick), and some that contain a listed word (Slaughter,
// Killer, Coon, Boner, Kuntz), so names get a gentler check: only the
// "anywhere" list, minus words that are also real surnames, never the
// whole-word list. The first and last name are also read together, which
// is what catches the well-known joke names ("Mike Hunt", "Ben Dover").
const SURNAME_SAFE = new Set(["slaughter", "killer", "coon", "boner", "guts", "niger", "sexy", "isis", "kunt", "torture"]);
const PERSON_ANYWHERE = ANYWHERE.filter((w) => !SURNAME_SAFE.has(w));

// Well-known joke names, matched only as an exact first+last pair, so
// "Ben" or "Hunt" on their own are fine
const PRANK_NAMES = new Set([
  "mikehunt", "mikehawk", "mikeoxlong", "mikelitoris", "mikerotch", "mikerotchburns", "hughjass", "hughjanus",
  "hughgrection", "hughgerection", "hughmungus", "bendover", "benderover", "dixienormus", "seymourbutts",
  "seymourass", "ivanatinkle", "anitadick", "anitabath", "harrybalzac", "harryballs", "jennytalia", "phillmccracken",
  "philmccracken", "heywoodjablowme", "heywoodjablome", "amandahugginkiss", "ollieklitoris", "maeyourdick",
  "jackmehoff", "jackmeoff", "jackhoff", "oliverclothesoff", "pennytration", "biggusdickus",
]);

function nameHasBadWord(text) {
  let plain = readLeet(text).replace(/[^a-z]/g, "");
  for (const ok of ALLOWED) plain = plain.split(ok).join("_");
  return PERSON_ANYWHERE.some((bad) => plain.includes(bad));
}

// True if a person's first and/or last name is offensive or a joke name
function isOffensivePersonName(firstName, lastName) {
  const first = String(firstName || "");
  const last = String(lastName || "");
  if (nameHasBadWord(first) || nameHasBadWord(last)) return true;
  const together = readLeet(first + last).replace(/[^a-z]/g, "");
  if (PRANK_NAMES.has(together)) return true;
  // Joke words that only appear across the two names ("Heywood Jablowme")
  return ["blowme", "blowjob", "fuck", "shit", "cunt", "suckmy", "suckit"].some((w) => together.includes(w));
}

const OFFENSIVE_PERSON_NAME_MESSAGE =
  "Please enter your real first and last name. Names with profanity, slurs or joke names aren't accepted.";

module.exports = { isOffensiveName, OFFENSIVE_NAME_MESSAGE, isOffensivePersonName, OFFENSIVE_PERSON_NAME_MESSAGE };
