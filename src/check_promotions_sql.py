"""Test van de promotie-database (RLS, validatie, prijzen) op een wegwerp-PostgreSQL met supabase/schema.sql.
Gebruik: python3 src/check_promotions_sql.py [host] [poort]   (de database 't' moet het schema bevatten, rollen anon/authenticated bestaan)"""
import subprocess, sys, datetime, json
HOST = sys.argv[1] if len(sys.argv) > 1 else "/home/claude/pgtest"
PORT = sys.argv[2] if len(sys.argv) > 2 else "5433"
ADMIN = "11111111-1111-1111-1111-111111111111"
USER = "22222222-2222-2222-2222-222222222222"
fails = []

def sql(q, role=None, uid=None):
    pre = ""
    if role: pre += f"set role {role};"
    if uid: pre += f"select set_config('request.jwt.claim.sub','{uid}',false);"
    p = subprocess.run(["psql", "-h", HOST, "-p", PORT, "-U", "claude", "-d", "t", "-v", "ON_ERROR_STOP=1", "-At", "-q"],
                       input=pre + q, capture_output=True, text=True)
    out = "\n".join(l for l in p.stdout.splitlines() if l.strip() and not l.startswith(("SET", "set_config")) and l != uid)
    return p.returncode, out.strip(), p.stderr.strip()

def ok(name, cond, info=""):
    print(("  ok   " if cond else "  FOUT ") + name + (f"  [{info}]" if (not cond and info) else ""))
    if not cond: fails.append(name)

def expect(name, q, role=None, uid=None, out_has=None):
    rc, out, err = sql(q, role, uid)
    ok(name, rc == 0 and (out_has is None or out_has in out), f"rc={rc} out={out} err={err[:160]}")
    return out

def denied(name, q, role=None, uid=None, why=None):
    rc, out, err = sql(q, role, uid)
    ok(name, rc != 0 and (why is None or why in err), f"rc={rc} out={out} err={err[:160]}")

d = datetime.date.today()
def iso(n): return (d + datetime.timedelta(days=n)).isoformat()
wed = d + datetime.timedelta(days=(2 - d.weekday()) % 7 + 14)  # woensdag, 2-3 weken verder: binnen openingsuren en max_days_ahead
W = wed.isoformat(); W2 = (wed + datetime.timedelta(days=7)).isoformat()

# --- opruimen + basisgegevens
sql(f"""truncate public.bookings, public.promotions, public.admins cascade; delete from auth.users;
insert into auth.users(id,email) values ('{ADMIN}','aida@test.be'),('{USER}','x@test.be');
insert into public.admins(user_id) values ('{ADMIN}');
set timezone='Europe/Brussels';
insert into public.promotions(title,discount_type,discount_value,service_slug,start_date,end_date,popup_delay) values
 ('Lopend 20% back','percentage',20,'back-in-control','{iso(-1)}','{iso(30)}',3),
 ('Vast 10 mind','fixed',10,'mind-control','{iso(0)}','{iso(0)}',0),
 ('Verlopen','percentage',30,'back-in-control','{iso(-10)}','{iso(-1)}',0),
 ('Toekomst','percentage',30,'back-in-control','{iso(1)}','{iso(10)}',0);
insert into public.promotions(title,discount_type,discount_value,service_slug,start_date,end_date,is_active) values
 ('Uitgeschakeld','percentage',30,'back-in-control','{iso(-1)}','{iso(10)}',false);
insert into public.promotions(title,discount_type,discount_value,promo_code,start_date,end_date) values
 ('Code alle','percentage',10,'welkom10','{iso(-1)}','{iso(30)}');""")

print("RLS: bezoeker (anon)")
out = expect("anon ziet enkel lopende promoties", "select title from public.promotions order by title", "anon")
ok("  lopend + vast (start=eind=vandaag) + code zichtbaar; verlopen/toekomst/uit niet",
   out.splitlines() == ["Code alle", "Lopend 20% back", "Vast 10 mind"], out)
denied("anon kan promo_code niet lezen", "select promo_code from public.promotions", "anon", why="permission denied")
denied("anon select * geweigerd (zou code lekken)", "select * from public.promotions", "anon", why="permission denied")
expect("anon ziet requires_code zonder de code", "select title, requires_code from public.promotions where title='Code alle'", "anon", out_has="Code alle|t")
denied("anon kan niet toevoegen", "insert into public.promotions(title,discount_type,discount_value,start_date,end_date) values ('x','fixed',5,current_date,current_date)", "anon", why="permission denied")
denied("anon kan niet wijzigen", "update public.promotions set is_active=false", "anon", why="permission denied")
denied("anon kan niet verwijderen", "delete from public.promotions", "anon", why="permission denied")
denied("anon kan boekingen niet lezen", "select * from public.bookings", "anon", why="permission denied")
print("RLS: ingelogd maar geen admin")
out = expect("niet-admin ziet geen promoties", "select count(*) from public.promotions", "authenticated", USER)
ok("  0 rijen", out == "0", out)
denied("niet-admin kan niet toevoegen", "insert into public.promotions(title,discount_type,discount_value,start_date,end_date) values ('x','fixed',5,current_date,current_date)", "authenticated", USER, why="row-level security")
expect("niet-admin wijzigt 0 rijen", "with u as (update public.promotions set is_active=false returning 1) select count(*) from u", "authenticated", USER, out_has="0")
expect("niet-admin verwijdert 0 rijen", "with u as (delete from public.promotions returning 1) select count(*) from u", "authenticated", USER, out_has="0")

print("Admin: aanmaken, bewerken, activeren, verwijderen + validatie")
ins = lambda cols, vals: f"insert into public.promotions({cols}) values ({vals})"
base = f"'TT','percentage',10,'{iso(0)}','{iso(5)}'"
bc = "title,discount_type,discount_value,start_date,end_date"
expect("admin ziet alles (6 + code zichtbaar)", "select count(*), count(promo_code) from public.promotions", "authenticated", ADMIN, out_has="6|1")
expect("admin maakt promotie aan (code in kleine letters -> hoofdletters)", ins(bc + ",promo_code", base + ",'zomer15'"), "authenticated", ADMIN)
out = expect("  code opgeslagen als ZOMER15", "select promo_code from public.promotions where title='TT'", "authenticated", ADMIN)
ok("  hoofdletters", out == "ZOMER15", out)
denied("einddatum voor startdatum geweigerd", ins(bc, f"'TT','percentage',10,'{iso(5)}','{iso(0)}'"), "authenticated", ADMIN, why="promotions_dates_ok")
denied("negatief percentage geweigerd", ins(bc, f"'TT','percentage',-5,'{iso(0)}','{iso(5)}'"), "authenticated", ADMIN, why="promotions_discount_ok")
denied("percentage 0 geweigerd", ins(bc, f"'TT','percentage',0,'{iso(0)}','{iso(5)}'"), "authenticated", ADMIN, why="promotions_discount_ok")
denied("percentage 80 (te hoog) geweigerd", ins(bc, f"'TT','percentage',80,'{iso(0)}','{iso(5)}'"), "authenticated", ADMIN, why="promotions_discount_ok")
denied("negatieve vaste korting geweigerd", ins(bc, f"'TT','fixed',-1,'{iso(0)}','{iso(5)}'"), "authenticated", ADMIN, why="promotions_discount_ok")
denied("vaste korting € 500 geweigerd", ins(bc, f"'TT','fixed',500,'{iso(0)}','{iso(5)}'"), "authenticated", ADMIN, why="promotions_discount_ok")
denied("vaste korting hoger dan prijs behandeling geweigerd", ins(bc + ",service_slug", f"'TT','fixed',60,'{iso(0)}','{iso(5)}','back-in-control'"), "authenticated", ADMIN, why="korting_hoger_dan_prijs")
denied("onbekende behandeling geweigerd (FK)", ins(bc + ",service_slug", f"'TT','fixed',5,'{iso(0)}','{iso(5)}','bestaat-niet'"), "authenticated", ADMIN, why="foreign key")
denied("dubbele promocode geweigerd", ins(bc + ",promo_code", base + ",'ZOMER15'"), "authenticated", ADMIN, why="promotions_code_uidx")
denied("ongeldige promocode geweigerd", ins(bc + ",promo_code", base + ",'a b'"), "authenticated", ADMIN, why="promo_code")
denied("javascript:-afbeelding geweigerd", ins(bc + ",image_url", base + ",'javascript:alert(1)'"), "authenticated", ADMIN, why="image_url")
denied("popup_delay > 120 geweigerd", ins(bc + ",popup_delay", base + ",500"), "authenticated", ADMIN, why="popup_delay")
expect("admin bewerkt titel", "update public.promotions set title='TT2', show_banner=true where title='TT'", "authenticated", ADMIN)
expect("  updated_at is bijgewerkt", "select updated_at > created_at from public.promotions where title='TT2'", "authenticated", ADMIN, out_has="t")
expect("admin schakelt uit", "update public.promotions set is_active=false where title='TT2'", "authenticated", ADMIN)
out = expect("  anon ziet T2 nu niet", "select count(*) from public.promotions where title='TT2'", "anon"); ok("  0", out == "0", out)
expect("admin schakelt weer in", "update public.promotions set is_active=true, start_date=current_date where title='TT2'", "authenticated", ADMIN)
out = expect("  anon ziet T2 (start vandaag)", "select count(*) from public.promotions where title='TT2'", "anon"); ok("  1", out == "1", out)
expect("admin verwijdert", "delete from public.promotions where title='TT2'", "authenticated", ADMIN)
out = expect("  weg", "select count(*) from public.promotions where title='TT2'", "authenticated", ADMIN); ok("  0", out == "0", out)

print("Prijsberekening")
q = lambda s, c=None: f"select get_price_quote('{s}'" + (f",'{c}'" if c else "") + ")"
j = lambda r: json.loads(r)
r = j(expect("quote back-in-control (20 % van 50)", q("back-in-control"), "anon"))
ok("  list 50, korting 10, prijs 40", (r["list_price"], r["discount"], r["price"], r["promotion"]) == (50, 10, 40, "Lopend 20% back"), r)
r = j(expect("quote higher-self zonder promotie", q("higher-self"), "anon"))
ok("  75 zonder korting", (r["price"], r["discount"], r["promotion"]) == (75, 0, None), r)
r = j(expect("quote mind-control (vast € 10 van 40)", q("mind-control"), "anon"))
ok("  30", (r["list_price"], r["discount"], r["price"]) == (40, 10, 30), r)
r = j(expect("quote met geldige code (10 % van 75)", q("higher-self", "welkom10"), "anon"))
ok("  67,50 en code ok", (r["price"], r["code_status"]) == (67.5, "ok"), r)
r = j(expect("quote back-in-control + code: grootste korting wint, niet gecombineerd", q("back-in-control", "WELKOM10"), "anon"))
ok("  20 % (10) wint van 10 % (5)", (r["discount"], r["price"], r["promotion"]) == (10, 40, "Lopend 20% back"), r)
r = j(expect("quote met onbekende code", q("higher-self", "FOUT"), "anon"))
ok("  invalid, geen korting", (r["code_status"], r["price"]) == ("invalid", 75), r)
r = j(expect("quote met code op gratis intake", q("intakegesprek", "WELKOM10"), "anon"))
ok("  invalid, 0", (r["code_status"], r["price"]) == ("invalid", 0), r)
denied("quote onbekende behandeling", q("nope"), "anon", why="onbekende_behandeling")
denied("anon kan interne functie niet aanroepen", "select _pick_promotion('back-in-control',50,null,null)", "anon", why="permission denied")
r = j(expect("verlopen/toekomstige/uitgeschakelde promo's tellen niet mee (30 % niet toegepast)", q("back-in-control"), "anon"))
ok("  korting blijft 10", r["discount"] == 10, r)

print("Boeken")
def book(slot, email, code=None, expect_price=None, svc="back-in-control", role="anon", uid=None, day=None):
    W = day or globals()['W']
    args = f"'{svc}','{W}','{slot}','Klant','{email}'"
    named = f"p_service=>'{svc}', p_date=>'{W}', p_start=>'{slot}', p_name=>'Klant', p_email=>'{email}'"
    if code: named += f", p_promo_code=>'{code}'"
    if expect_price is not None: named += f", p_expected_price=>{expect_price}"
    return f"select book_appointment({named})"
r = j(expect("boeking met automatische promo", book("18:00", "a@test.be"), "anon"))
ok("  prijs 40, normaal 50, korting 10", (r["price"], r["list_price"], r["discount"]) == (40, 50, 10), r)
out = expect("  boeking bewaart prijzen apart", "select price_eur, list_price_eur, discount_eur, promotion_title from public.bookings where client_email='a@test.be'", "authenticated", ADMIN)
ok("  40|50|10|titel", out == "40.00|50.00|10.00|Lopend 20% back", out)
out = expect("  originele prijs in treatments ongewijzigd", "select price_eur from public.treatments where slug='back-in-control'", "authenticated", ADMIN); ok("  50", out == "50.00", out)
denied("zelfde e-mail opnieuw met verwachte prijs 40 -> prijs_gewijzigd:50", book("19:00", "a@test.be", expect_price=40), "anon", why="prijs_gewijzigd:50")
r = j(expect("zelfde e-mail zonder verwachte prijs: geen tweede korting", book("19:00", "a@test.be"), "anon"))
ok("  vol tarief 50", (r["price"], r["discount"]) == (50, 0), r)
denied("verkeerde verwachte prijs bij nieuw e-mailadres", book("16:30", "b@test.be", expect_price=45), "anon", why="prijs_gewijzigd:40")
r = j(expect("juiste verwachte prijs -> geboekt", book("16:30", "b@test.be", expect_price=40), "anon"))
ok("  40", r["price"] == 40, r)
denied("ongeldige code geweigerd", book("13:00", "c@test.be", code="NOPE"), "anon", why="ongeldige_code")
r = j(expect("geboekt met code WELKOM10 op higher-self", book("13:00", "c@test.be", code="welkom10", svc="higher-self", expect_price=67.5), "anon"))
ok("  67,50, code bewaard", (r["price"], r["discount"]) == (67.5, 7.5), r)
out = expect("  code in boeking", "select promo_code from public.bookings where client_email='c@test.be'", "authenticated", ADMIN); ok("  WELKOM10", out == "WELKOM10", out)
denied("code opnieuw door zelfde e-mail geweigerd", book("16:00", "c@test.be", code="WELKOM10", svc="higher-self"), "anon", why="code_al_gebruikt")
denied("hoofdletter-variant van e-mail telt als dezelfde klant", book("16:00", "C@Test.be", code="WELKOM10", svc="higher-self"), "anon", why="code_al_gebruikt")
r = j(expect("bestaande aanroep met 7 parameters werkt nog (positioneel)", f"select book_appointment('mind-control','{W}','20:00','Oud','oud@test.be','0470','nota')", "anon"))
ok("  mind-control 40 - 10 = 30", r["price"] == 30, r)
r = j(expect("zelfde dag, vaste korting ook zonder code (promo van vandaag)", "select get_price_quote('mind-control')", "anon")); ok("  30", r["price"] == 30, r)

print("Bestaande boeking behoudt prijs")
expect("promotie gewijzigd naar 50 %", "update public.promotions set discount_value=50 where title='Lopend 20% back'", "authenticated", ADMIN)
out = expect("  boeking a@ ongewijzigd", "select price_eur from public.bookings where client_email='a@test.be' and discount_eur>0", "authenticated", ADMIN); ok("  40", out == "40.00", out)
expect("promotie verwijderd", "delete from public.promotions where title='Lopend 20% back'", "authenticated", ADMIN)
out = expect("  boeking a@ behoudt prijs/korting/titel, promotion_id leeg", "select price_eur, list_price_eur, discount_eur, promotion_title, promotion_id is null from public.bookings where client_email='a@test.be' and discount_eur>0", "authenticated", ADMIN)
ok("  40|50|10|titel|t", out == "40.00|50.00|10.00|Lopend 20% back|t", out)
r = j(expect("nieuwe quote na verwijderen: geen korting meer", q("back-in-control"), "anon")); ok("  50", r["price"] == 50, r)

print("Annuleren geeft promotie weer vrij")
expect("promotie opnieuw aanmaken", f"insert into public.promotions(title,discount_type,discount_value,start_date,end_date,promo_code) values ('Code B','fixed',5,'{iso(-1)}','{iso(9)}','ZONNIG5')", "authenticated", ADMIN)
expect("boeking met ZONNIG5", book("14:00", "d@test.be", day=W2, code="ZONNIG5", svc="higher-self"), "anon")
denied("tweede keer zelfde e-mail", book("15:00", "d@test.be", day=W2, code="ZONNIG5", svc="higher-self"), "anon", why="code_al_gebruikt")
expect("admin annuleert eerste boeking", "update public.bookings set status='geannuleerd' where client_email='d@test.be'", "authenticated", ADMIN)
expect("code kan opnieuw", book("15:00", "d@test.be", day=W2, code="ZONNIG5", svc="higher-self"), "anon")

print("Vaste korting nooit onder 0 (clamp) en afronding")
expect("promo fixed 100 op alle behandelingen", f"insert into public.promotions(title,discount_type,discount_value,start_date,end_date,promo_code) values ('Groot','fixed',100,'{iso(0)}','{iso(2)}','GROOT100')", "authenticated", ADMIN)
r = j(expect("quote mind-control met GROOT100: prijs 0, niet negatief", q("mind-control", "GROOT100"), "anon")); ok("  0", (r["price"], r["discount"]) == (0, 40), r)
expect("percentage-afronding 33 %", f"insert into public.promotions(title,discount_type,discount_value,start_date,end_date,service_slug) values ('Derde','percentage',33,'{iso(0)}','{iso(2)}','iron-back-mind-reset')", "authenticated", ADMIN)
r = j(expect("  65 x 33 % = 21,45 -> 43,55", q("iron-back-mind-reset"), "anon")); ok("  43.55", r["price"] == 43.55, r)

print("\n" + ("ALLES GESLAAGD" if not fails else f"{len(fails)} FOUT(EN): " + "; ".join(fails)))
sys.exit(1 if fails else 0)
