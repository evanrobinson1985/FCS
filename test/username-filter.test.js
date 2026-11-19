const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { isOffensiveName } = require("../lib/username-filter");

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
