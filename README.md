# PatchLab

I built PatchLab to plan and check Cisco lab networks without racking a single cable. You drag
routers, switches and end devices onto a canvas and cable them together. PatchLab writes the IOS
configuration for every device, then predicts whether traffic actually gets through and explains
why when it doesn't.

It covers what I'd expect from a CCNA-level lab:
- VLANs, trunks and EtherChannel
- spanning tree
- inter-VLAN routing, static routes, OSPF, RIP and BGP
- DHCP and relays, ACLs, NAT/PAT and HSRP
- port security and DHCP snooping
- IPv6 with SLAAC and OSPFv3

There's a CLI lab mode where students configure every device from a simulated console and get
scored against the lab as designed, and an assistant that answers questions like "why can't PC1
ping PC2?" in plain English, with the fix commands for each device. It also has IPv4 and IPv6
subnet calculators, a VLSM planner, a step-by-step build guide, a printable answer sheet, config
import from `show running-config`, and export to Cisco Modeling Labs.

It's a single page of plain HTML, CSS and JavaScript, with no framework and nothing to install.
Labs save in your browser or to a `.json` file, and on Cloud Run each signed-in user gets their
own lab saved to their account.

PatchLab is an independent teaching tool, not a Cisco product. Cisco names only identify the
hardware being modelled, and the predictions are a model, not IOS, so confirm on real gear.

## Run it locally

You only need a web browser. [Node.js](https://nodejs.org) is optional, for the tests and the
single-file build.

**Mac**

```bash
git clone https://github.com/mlaslie/patchlab.git
cd patchlab
open index.html
```

**Windows**

```bat
git clone https://github.com/mlaslie/patchlab.git
cd patchlab
start index.html
```

No git? Use **Code → Download ZIP** on GitHub, unzip it and double-click `index.html`.

If your browser is strict about files opened from disk, serve the folder instead and browse to
http://localhost:8000:

```bash
python3 -m http.server 8000      # Mac
py -m http.server 8000           # Windows
```

With Node.js installed, the same commands work on both:

```bash
npm test         # run the test suite
npm run build    # bundle everything into dist/patchlab.html, one file you can share
```

## Deploy to Google Cloud Run

The container runs a small Node.js server (`server/server.js`, no dependencies) behind
Identity-Aware Proxy (IAP), so only the Google accounts you allow can open it. The server checks
the identity IAP signs into every request and keeps **each user's lab separate** in a Cloud
Storage bucket: everyone signs in and gets their own lab, which follows them to any computer.
The **Labs** menu has two lists: **Your labs** (on Cloud Run) and **Example labs** (the worked
labs that come with PatchLab). **New lab…** asks for a name and, on Cloud Run, adds the empty lab to
Your labs straight away; a name you already use is refused rather than overwriting that lab.
**Save lab as a file** still downloads the `.json` file, and on Cloud Run also stores the lab in
Your labs under its name, replacing the earlier copy. The × beside a lab in Your labs deletes it
after you confirm.
It scales to zero when idle and never runs more than one instance, to keep the cost near nothing.

You need the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), Node.js and a Google
Cloud project with billing turned on. Sign in once with `gcloud auth login`.

### Setup script

One script does everything: turns on the APIs, creates the bucket and the service account (with
access to that bucket only), builds and deploys, and gives each listed person sign-in access.

```bash
./scripts/setup.sh
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
```

It asks for each setting, showing a default in brackets: press Enter to keep it or type another.
The defaults come from [deploy/config.env](deploy/config.env), so edit that file to change them for
everyone:

| Setting | Default | What it is |
| --- | --- | --- |
| `ACCOUNT` | the account gcloud is signed in with | Google account the script runs as |
| `PROJECT_ID` | the project gcloud is set to | Google Cloud project |
| `REGION` | `us-central1` | Region for Cloud Run and the bucket |
| `SERVICE` | `patchlab` | Cloud Run service name |
| `BUCKET` | `<project>-patchlab-labs` | Bucket for users' labs (names are global) |
| `SERVICE_ACCOUNT` | `patchlab-run` | Account the app runs as |
| `IAP_USERS` | (none) | Who may sign in, comma-separated emails |
| `MEMORY`, `MIN_INSTANCES`, `MAX_INSTANCES`, `CONCURRENCY` | `256Mi`, `0`, `1`, `15` | Size and cost limits |

Your answers are saved to `deploy/config.local.env` (not committed) and become the defaults the
next time, so shipping a change is just running the script again and pressing Enter. Anything
that already exists is kept. To see the commands without running them, use
`DRY_RUN=1 ./scripts/setup.sh` or `scripts\setup.ps1 -DryRun`.

### By hand

The same steps as single-line commands. Replace `PROJECT_ID`, `PROJECT_NUMBER` (from
`gcloud projects describe PROJECT_ID`) and `you@example.com`.

```bash
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iap.googleapis.com storage.googleapis.com
gcloud storage buckets create gs://PROJECT_ID-patchlab-labs --location=us-central1 --uniform-bucket-level-access --public-access-prevention
gcloud iam service-accounts create patchlab-run --display-name="PatchLab on Cloud Run"
gcloud storage buckets add-iam-policy-binding gs://PROJECT_ID-patchlab-labs --member=serviceAccount:patchlab-run@PROJECT_ID.iam.gserviceaccount.com --role=roles/storage.objectUser
npm run build
gcloud run deploy patchlab --source . --region us-central1 --iap --no-allow-unauthenticated --service-account patchlab-run@PROJECT_ID.iam.gserviceaccount.com --set-env-vars BUCKET=PROJECT_ID-patchlab-labs,IAP_AUDIENCE=/projects/PROJECT_NUMBER/locations/us-central1/services/patchlab --memory 256Mi --min-instances 0 --max-instances 1 --concurrency 15
gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=patchlab --region=us-central1 --member=user:you@example.com --role=roles/iap.httpsResourceAccessor --condition=None
```

### Letting people outside your organization sign in

If your project belongs to a Google Workspace or Cloud organization, IAP's built-in sign-in
admits only that organization's accounts. To let others in, such as personal gmail.com accounts:

1. In the Google Cloud console, open **Google Auth Platform → Audience** for the project and set
   the user type to **External** (fill in the app name and support email if asked). Leaving the
   app in **Testing** is fine; add each outside person under **Test users**.
2. Open **Security → Identity-Aware Proxy**, find the Cloud Run service, and switch it from the
   Google-managed OAuth client to a custom one (the console can create it for you).
3. Give each person access with `IAP_USERS` in the script, or the `add-iam-policy-binding`
   command above.

An organization policy that limits members to your own domain
(`iam.allowedPolicyMemberDomains`) also blocks outside accounts; the script reports that if it
happens.

The deploy prints the service URL. Open it and sign in with an allowed account; your address
shows in the top bar with the save status. To try the server on your own machine, with a fake
signed-in user, run `npm run serve` and open http://localhost:8080. Opened as a plain file, the
app saves only in that browser.

## Use it

1. Drag devices from the left onto the canvas. Clicking one adds it too.
2. Click **Ethernet**, press on the source device and drag to the destination (or pull
   from a device's **+** handle). PatchLab picks free ports and a likely link type.
3. Click a cable to choose its source and destination interfaces, and to set access VLAN,
   trunk (native and allowed VLANs) or routed mode. Under **EtherChannel**, start a new
   Port-channel with the cable or add it to an existing bundle between the same two
   devices; the x beside a member takes that cable back out.
4. Click a device to set interfaces, sub-interfaces, SVIs, loopbacks, static routes,
   OSPF, RIP, BGP, DHCP and ACLs.
5. For DHCP, add pools on a router or Layer 3 switch (**DHCP** tab; **Create from
   interfaces** builds one per gateway subnet), and set each host to **DHCP**. When the
   server sits on another subnet, put its address in the gateway's **Relay** field
   (`ip helper-address`). Verify shows the lease each host should get, or why it gets none.
6. On the **ACLs** tab, extended rules match a protocol (ip, tcp, udp, icmp, ospf, eigrp,
   gre, esp, ahp), source and destination addresses, and for tcp and udp a source and a
   destination port with eq, neq, gt, lt or range. Ports take a number or an IOS keyword
   such as `www`. Any rule can add `log`.
7. The **Routes** tab on a router or Layer 3 switch shows the predicted `show ip route`
   (as a list naming the device each route came from, or as CLI text), filtered by source.
   It also lists OSPF, RIP and BGP neighbors with their state and route counts, routes
   that lost to a lower administrative distance, and the predicted `show ip bgp`.
8. Switches have an **STP** tab (bridge priority per VLAN, the root, each port's role and
   the predicted `show spanning-tree`) and a **Security** tab (port security on access
   ports, DHCP snooping with trusted ports). Blocked ports show as red marks on the canvas.
9. Routers and Layer 3 switches have a **NAT** tab (inside and outside interfaces, PAT
   overload, static entries). Any routed interface, sub-interface or SVI takes an HSRP group
   and an IPv6 address; OSPFv3 and IPv6 static routes sit on the Routing tab, and hosts can
   use SLAAC or a static IPv6 address. The **Internet** device stands in for the ISP.
10. **Import config** on a device reads a pasted `show running-config` and reports the lines
   it did not understand.
11. **Lab** holds the VLAN list and base settings. **Configs** has the paste-ready CLI;
   **Show** narrows it to one feature, such as DHCP, EtherChannel, ACLs, NAT or IPv6.
   **Verify** lists problems, shows a ping matrix and traces any test traffic (IPv4 or IPv6)
   hop by hop, animating the packet on the canvas with the route, ACL or NAT step at each hop.
12. **Tools** (top bar, beside **Designer**) opens a full-width page with an IPv4 subnet calculator and VLSM planner (which can write subnets into the
   VLAN list), an IPv6 prefix calculator that splits a block into numbered subnets, the step-by-step build guide with a check after each step, and exports: SVG and
   PNG drawings, a printable answer sheet, and a Cisco Modeling Labs topology file.
13. **CLI lab** (top bar) turns the designed lab into an exercise. Every device starts at
   factory defaults with only its cables, and each has a console: IOS modes, abbreviations
   (`conf t`, `int g0/1`, `no shut`), Tab completion, `?`, history, `show` commands, `| include`
   and `ping`; PCs take `ipconfig` and `ping`. Router interfaces and SVIs stay shut until
   `no shutdown`, and an access port in a VLAN the switch never created stays inactive, as on real
   gear. The score compares every host pair with the designed lab: what should work, and what
   should stay blocked. The lab brief lists each device's cables and addresses. What students
   type saves with the lab file.
14. **Ask PatchLab** (Verify tab, and in the CLI lab) takes plain questions: "why can't PC1 ping
   PC2?", "can Staff1 reach WEB1 on port 80?", "why doesn't PC3 get an address?", "why aren't R1
   and R2 OSPF neighbors?", "what's wrong with my lab?". It runs the test and names the cause,
   such as "The mask on R1 interface Gi0/0 is /24, but R2 uses /30". Then pick 1 to ask another
   question, 2 for more troubleshooting detail (the hop-by-hop trace, related problems and the
   `show` commands to confirm on real gear), or 3 for the commands that fix it on each device.
   In the CLI lab, the fixes are the exact differences from the designed lab.

| Key | Action |
| --- | --- |
| V / E | Select, Ethernet tool |
| F | Fit to screen |
| Delete | Remove the selection |
| Esc | Cancel and return to Select |
| Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z | Undo, redo |

## Hardware

| Type | Models |
| --- | --- |
| Routers | ISR 1941, 2901, 2911, 4221, 4321, 2811 |
| Access switches | Catalyst 2960-24TT, 2960-48TT, 2960-X 24TS |
| Multilayer switches | Catalyst 3560-24PS, 3650-24PS, 9200L-24T-4G |
| End devices | PC, laptop, server, printer, Internet (stands in for the ISP) |

Model quirks are handled per device, such as `switchport trunk encapsulation dot1q` on the
3560 only, and bare `channel-group N` on ISR G2 routers. Add a model in `js/catalog.js`.

## What Verify does and does not tell you

Verify is a model built from the project data, not IOS. It computes broadcast domains,
converges OSPF, RIP and BGP, hands out DHCP leases (lowest free address, as IOS does, so a
real lab may differ once leases have churned), and walks packets through routing tables and
ACLs. It also elects a Rapid PVST+ root and blocks redundant ports per VLAN, picks the HSRP
active router, translates NAT and PAT, enforces port security and DHCP snooping, and runs IPv6
with SLAAC, static routes and OSPFv3. It does not model timers, so it predicts a network where
every device started at the same time: HSRP and DR elections without preempt can differ on real
gear, and spanning tree ties fall to made-up MAC addresses. IPv6 traffic ignores ACLs and NAT.
Test traffic leaves the client from port 49152 and returns from the service port, so source-port rules match replies. Inbound ACLs also
filter OSPF hellos, RIP updates, BGP's TCP 179 session and DHCP requests at the interface
that receives them; ACLs on routers in between are not checked for those. OSPF areas are checked for link agreement, but routes
are computed as one flat domain. The generated CLI has been reviewed and unit tested for
its command structure, but not pasted into physical hardware, so confirm on real gear.

## Layout

```
index.html        page shell and device glyphs
css/app.css       styles and theme tokens
js/net.js         IPv4 maths, VLAN lists, ACL address parsing
js/catalog.js     hardware models and their quirks
js/model.js       project document and editing helpers
js/configgen.js   IOS generator
js/stp.js         Rapid PVST+ root election and port roles
js/simulate.js    L2 domains, routing convergence, HSRP, NAT, packet walks
js/ipv6.js        IPv6 addressing, SLAAC, OSPFv3 and ping
js/subnet.js      IPv4 and IPv6 subnet calculators, VLSM planner
js/export.js      SVG drawing and Cisco Modeling Labs export
js/guide.js       build guide and answer sheet
js/importer.js    show running-config import
js/practice.js    CLI lab console, student lab and scoring
js/troubleshoot.js  question answering and fix suggestions
js/cliview.js     CLI lab page
js/validate.js    configuration checks and fix advice
js/samples.js     worked example labs
js/canvas.js      SVG canvas, drag, pan, zoom, cabling
js/inspector.js   right-hand panels
js/app.js         state, undo, persistence, palette, menus
server/server.js  Cloud Run server: IAP identity check and per-user lab storage
scripts/setup.sh  Cloud Run setup and deploy (setup.ps1 on Windows)
deploy/config.env defaults for the setup scripts
test/run.js       Node test suite (npm test)
```
