const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { isOffensiveName, isOffensivePersonName } = require("../lib/username-filter");

describe("username filter", () => {
  test("blocks profanity, slurs and gruesome words, however they're disguised", () => {
    for (const name of [
      "fuckface", "F_u_c_k", "Sh1tLord", "fuuuuck", "N1gg3r", "BigRapeGuy", "rape_man", "Corpse.Eater", "MurderMan",
      "dead-baby", "KillYourself", "Beheader99", "assclown", "cum_dumpster", "Bitch420", "heywoodjablowme",
      "Hitler88", "KKK_member", "Gore", "DickHead", "xXslaughterXx", "b00bs", "r4pist", "kys", "pedophile",
      "Bonglord42069", "Mutilator", "big_dick", "my_anus",
    ]) {
      assert.equal(isOffensiveName(name), true, name);
    }
  });

  test("leaves ordinary caver names and real words alone", () => {
    for (const name of [
      "Webmaster-Evan", "Cavertothecore", "MrDanNFam", "Chose352", "TomTurner", "Uriahpryor", "Rswfla", "Fcs",
      "Scunthorpe", "therapist", "retardant_gel", "Nazir", "Cockburn", "Hancock", "DickBlenz", "assassin", "grapefruit",
      "cucumber", "Gorecki", "skillful", "raccoon", "Sussex", "Analyst", "Killarney", "cumberland", "Butterfly",
      "bassdiver", "Peacock", "Sinkhole", "Karst", "Skeleton", "Skull", "BoneCave", "DarkZone", "spelunker42",
      "bloodhound", "DeadmansCave", "sharp_shooter", "Tetanus", "Manuscript", "Pussycat", "Cumming", "Sexton",
      "Kathleen", "Cassandra", "Titus", "Shelley", "Dixon",
    ]) {
      assert.equal(isOffensiveName(name), false, name);
    }
  });
});

describe("first and last name filter", () => {
  test("blocks profanity, slurs and well-known joke names", () => {
    for (const [first, last] of [
      ["Heywood", "Jablowme"], ["Mike", "Hunt"], ["Ben", "Dover"], ["Hugh", "Jass"], ["Seymour", "Butts"],
      ["Dixie", "Normus"], ["Fuck", "You"], ["Shit", "Head"], ["Adolf", "Hitler"], ["Corpse", "Eater"],
      ["Jack", "Mehoff"], ["Amanda", "Hugginkiss"], ["Phil", "McCracken"],
    ]) {
      assert.equal(isOffensivePersonName(first, last), true, `${first} ${last}`);
    }
  });

  test("accepts real names, including surnames that are also words", () => {
    for (const [first, last] of [
      ["Evan", "Robinson"], ["Daniel", "Aumack"], ["Shane", "Phillips"], ["Tom", "Turner"], ["Uriah", "Pryor"],
      ["Scott", "Wilder"], ["Al", "Gore"], ["Enos", "Slaughter"], ["Dick", "Smith"], ["Richard", "Cockburn"],
      ["John", "Hancock"], ["Mary", "Butts"], ["Bob", "Coon"], ["Joe", "Blood"], ["Mike", "Hunter"], ["Ben", "Dovey"],
      ["Hugh", "Jackman"], ["Dixie", "Carter"], ["Anita", "Baker"], ["Barry", "White"], ["Ann", "Killer"],
      ["Kathy", "Kuntz"], ["Mary-Jane", "O'Neil"], ["José", "St. John"], ["Jo", "Boner"], ["Peter", "Fagg"],
      ["Ted", "Crapper"],
    ]) {
      assert.equal(isOffensivePersonName(first, last), false, `${first} ${last}`);
    }
  });
});
