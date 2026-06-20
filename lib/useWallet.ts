"use client";

import { ethers } from "ethers";
import { useCallback, useEffect, useRef, useState } from "react";
import { ensureDiscovered, pickDetail, pickProvider, setChosenRdns, type Eip1193Provider } from "./wallet";
import { ARC_CHAIN_HEX, ARC_RPC, switchToArc } from "./arcNetwork";

// localStorage flag remembering an explicit user disconnect across reloads.
const OPT_OUT_FLAG = ["cb", "arc", "v1", "optout"].join(":");

const isArc = (hexId: unknown) => String(hexId).toLowerCase() === ARC_CHAIN_HEX.toLowerCase();

export function useWallet() {
  const [account, setAccount] = useState("");
  const [balance, setBalance] = useState("");
  const [chainOk, setChainOk] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const optedOutRef = useRef(false);
  const listenRef = useRef<{ provider: Eip1193Provider; cleanup: () => void } | null>(null);

  const refreshBalance = useCallback(async (addr: string) => {
    try {
      const reader = new ethers.JsonRpcProvider(ARC_RPC);
      const raw = await reader.getBalance(addr);
      setBalance(parseFloat(ethers.formatEther(raw)).toFixed(3));
    } catch {
      setBalance("—");
    }
  }, []);

  // Wire up account/chain change listeners on a freshly chosen provider.
  const subscribe = useCallback(
    (prov: Eip1193Provider) => {
      if (!prov?.on) return;
      if (listenRef.current?.provider === prov) return;
      listenRef.current?.cleanup();
      const onAcc = (a: unknown) => {
        if (optedOutRef.current) return;
        const list = a as string[];
        if (list.length) {
          setAccount(list[0]);
          refreshBalance(list[0]);
        } else {
          setAccount("");
          setBalance("");
          setChainOk(false);
        }
      };
      const onChain = (c: unknown) => setChainOk(isArc(c));
      prov.on("accountsChanged", onAcc);
      prov.on("chainChanged", onChain);
      listenRef.current = {
        provider: prov,
        cleanup: () => {
          prov.removeListener?.("accountsChanged", onAcc);
          prov.removeListener?.("chainChanged", onChain);
        },
      };
    },
    [refreshBalance]
  );

  const disconnect = useCallback(() => {
    optedOutRef.current = true;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(OPT_OUT_FLAG, "1");
      } catch {
        /* ignore */
      }
    }
    setAccount("");
    setBalance("");
    setChainOk(false);
  }, []);

  const connect = useCallback(async () => {
    optedOutRef.current = false;
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(OPT_OUT_FLAG);
      } catch {
        /* ignore */
      }
    }
    await ensureDiscovered();
    const detail = pickDetail();
    const prov = detail?.provider;
    if (!prov) return;
    setChosenRdns(detail.rdns);
    setConnecting(true);
    try {
      const accs = (await prov.request({ method: "eth_requestAccounts" })) as string[];
      if (!accs?.length) return;
      setAccount(accs[0]);
      subscribe(prov);
      try {
        await switchToArc(prov);
      } catch {
        /* user declined the network switch */
      }
      try {
        const id = (await prov.request({ method: "eth_chainId" })) as string;
        setChainOk(isArc(id));
      } catch {
        setChainOk(false);
      }
      refreshBalance(accs[0]);
    } catch {
      /* user rejected */
    } finally {
      setConnecting(false);
    }
  }, [refreshBalance, subscribe]);

  // On mount: honour a prior opt-out, otherwise silently reattach an existing session.
  useEffect(() => {
    if (typeof window !== "undefined" && window.localStorage.getItem(OPT_OUT_FLAG) === "1") {
      optedOutRef.current = true;
    }
    (async () => {
      await ensureDiscovered();
      const prov = pickProvider();
      if (!prov) return;
      if (!optedOutRef.current) {
        try {
          const accs = (await prov.request({ method: "eth_accounts" })) as string[];
          if (accs.length) {
            setAccount(accs[0]);
            refreshBalance(accs[0]);
            prov
              .request({ method: "eth_chainId" })
              .then((id) => setChainOk(isArc(id)))
              .catch(() => {});
          }
        } catch {
          /* ignore */
        }
      }
      subscribe(prov);
    })();
    return () => {
      listenRef.current?.cleanup();
      listenRef.current = null;
    };
  }, [refreshBalance, subscribe]);

  return { account, balance, chainOk, connecting, connect, disconnect, refreshBalance };
}
