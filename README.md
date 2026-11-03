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

It also has IPv4 and IPv6 subnet calculators, a VLSM planner, a step-by-step build guide, a printable answer sheet, config
import from `show running-config`, and export to Cisco Modeling Labs.

It's a single page of plain HTML, CSS and JavaScript, with no framework, no backend and nothing
to install. Labs save in your browser or to a `.json` file.

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

The `Dockerfile` serves the bundled `dist/patchlab.html` from nginx. These steps keep it private
behind Identity-Aware Proxy (IAP), so only the Google accounts you allow can open it. They also
cap the cost: it scales to zero when idle and never runs more than one instance.

You need the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install), Node.js and a Google
Cloud project with billing turned on. Replace `PROJECT_ID` and `you@example.com` below. Each
command is a single line, so it works in Terminal, PowerShell or Command Prompt.

```bash
gcloud auth login
gcloud config set project PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com iap.googleapis.com
```

Build the bundle, then deploy from the project folder:

```bash
npm run build
gcloud run deploy patchlab --source . --region us-central1 --iap --no-allow-unauthenticated --memory 128Mi --min-instances 0 --max-instances 1 --concurrency 15
```

Give yourself (and anyone else) access:

```bash
gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=patchlab --region=us-central1 --member=user:you@example.com --role=roles/iap.httpsResourceAccessor --condition=None
```

The deploy prints the service URL. Open it and sign in with an allowed account. To ship a
change, run `npm run build` and the `gcloud run deploy` line again.

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
12. **Tools** has an IPv4 subnet calculator and VLSM planner (which can write subnets into the
   VLAN list), an IPv6 prefix calculator that splits a block into numbered subnets, the step-by-step build guide with a check after each step, and exports: SVG and
   PNG drawings, a printable answer sheet, and a Cisco Modeling Labs topology file.

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
js/validate.js    configuration checks and fix advice
js/samples.js     worked example labs
js/canvas.js      SVG canvas, drag, pan, zoom, cabling
js/inspector.js   right-hand panels
js/app.js         state, undo, persistence, palette, menus
test/run.js       Node test suite (npm test)
```
