//! Bounded producer-to-WebView flow control.
//!
//! `Emitter::emit_to` only queues a WebView evaluation; success does not mean
//! JavaScript consumed the event. Producers reserve a slot before emitting and
//! the frontend acknowledges after its event callback has accepted the payload.
//! This bounds the otherwise-unbounded native/UI event queue while naturally
//! applying backpressure to child stdout/LSP pipes.

use std::sync::{Condvar, Mutex};

struct State {
    in_flight: usize,
    cancelled: bool,
}

pub(crate) struct OutputFlow {
    capacity: usize,
    state: Mutex<State>,
    ready: Condvar,
}

impl OutputFlow {
    pub(crate) fn new(capacity: usize) -> Self {
        assert!(capacity > 0, "output-flow capacity must be non-zero");
        Self {
            capacity,
            state: Mutex::new(State {
                in_flight: 0,
                cancelled: false,
            }),
            ready: Condvar::new(),
        }
    }

    /// Wait for and reserve one in-flight event slot. Returns false after cancel.
    pub(crate) fn reserve(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while !state.cancelled && state.in_flight >= self.capacity {
            state = self
                .ready
                .wait(state)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        if state.cancelled {
            return false;
        }
        state.in_flight += 1;
        true
    }

    /// Reserve without waiting. Used by the filesystem coalescer, which must
    /// keep receiving and merging native notifications while JavaScript sleeps.
    pub(crate) fn try_reserve(&self) -> bool {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.cancelled || state.in_flight >= self.capacity {
            return false;
        }
        state.in_flight += 1;
        true
    }

    pub(crate) fn acknowledge(&self, count: usize) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.in_flight = state.in_flight.saturating_sub(count);
        self.ready.notify_all();
    }

    pub(crate) fn cancel(&self) {
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.cancelled = true;
        self.ready.notify_all();
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .cancelled
    }

    #[cfg(test)]
    fn in_flight(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .in_flight
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    #[test]
    fn flow_waits_at_capacity_until_acknowledged() {
        let flow = Arc::new(OutputFlow::new(2));
        assert!(flow.reserve());
        assert!(flow.reserve());

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker_flow = flow.clone();
        std::thread::spawn(move || {
            let reserved = worker_flow.reserve();
            let _ = done_tx.send(reserved);
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());

        flow.acknowledge(1);
        assert_eq!(
            done_rx.recv_timeout(Duration::from_secs(1)),
            Ok(true),
            "an acknowledgement must release one waiting producer"
        );
        assert_eq!(flow.in_flight(), 2);
    }

    #[test]
    fn cancel_unblocks_waiters_and_prevents_new_reservations() {
        let flow = Arc::new(OutputFlow::new(1));
        assert!(flow.reserve());

        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker_flow = flow.clone();
        std::thread::spawn(move || {
            let _ = done_tx.send(worker_flow.reserve());
        });
        assert!(done_rx.recv_timeout(Duration::from_millis(50)).is_err());

        flow.cancel();
        assert_eq!(done_rx.recv_timeout(Duration::from_secs(1)), Ok(false));
        assert!(!flow.try_reserve());
        assert!(flow.is_cancelled());
    }
}
