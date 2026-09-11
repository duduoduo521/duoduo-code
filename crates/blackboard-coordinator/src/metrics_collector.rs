//! Metrics collection and aggregation.
//!
//! Provides a unified interface for recording and querying metrics.
//! Supports real-time aggregation (average, rate, count) over time windows.

use anyhow::Result;
use std::sync::Arc;

use blackboard_store::BlackboardStore;
use duo_types::*;

/// Metrics collector with aggregation capabilities.
pub struct MetricsCollector {
    store: Arc<BlackboardStore>,
}

impl MetricsCollector {
    pub fn new(store: Arc<BlackboardStore>) -> Self {
        Self { store }
    }

    /// Record a metric event.
    pub fn record(
        &self,
        name: &MetricName,
        value: f64,
        agent_id: Option<&str>,
        file_path: Option<&str>,
        extra: Option<&str>,
    ) -> Result<()> {
        self.store.record_metric(name, value, agent_id, file_path, extra)
    }

    /// Record agent work duration.
    pub fn record_work_duration(&self, agent_id: &str, duration_secs: f64) -> Result<()> {
        self.store.record_metric(
            &MetricName::AgentAverageWorkDuration,
            duration_secs,
            Some(agent_id),
            None,
            None,
        )
    }

    /// Compute the conflict rate over recent writes.
    /// Returns (conflicts / total_writes) for recent entries.
    pub fn compute_conflict_rate(&self, recent_n: usize) -> Result<f64> {
        self.store.compute_conflict_rate(recent_n)
    }

    /// Compute the average of a metric over recent entries.
    pub fn compute_average(&self, metric_name: &str, limit: usize) -> Result<f64> {
        let records = self.store.query_metrics(metric_name, Some(limit))?;
        if records.is_empty() {
            return Ok(0.0);
        }
        let sum: f64 = records.iter().map(|r| r.metric_value).sum();
        Ok(sum / records.len() as f64)
    }

    /// Get the count of a metric.
    pub fn compute_count(&self, metric_name: &str, limit: usize) -> Result<usize> {
        let records = self.store.query_metrics(metric_name, Some(limit))?;
        Ok(records.len())
    }

    /// Get a metrics summary for the session.
    pub fn get_summary(&self) -> Result<MetricsSummary> {
        let conflict_rate = self.compute_conflict_rate(50)?;
        let avg_work_duration = self.compute_average("agent_average_work_duration", 100)?;
        let degradation_count = self.compute_count("degradation_trigger_count", 1000)?;
        let llm_fault_count = self.compute_count("llm_fault_count", 1000)?;
        let ts_intercept_count = self.compute_count("tree_sitter_intercept_count", 1000)?;
        let dep_adapt_count = self.compute_count("dependency_adapt_count", 1000)?;
        let ack_timeout_count = self.compute_count("notification_ack_timeout_count", 1000)?;
        let dup_resource_count = self.compute_count("duplicate_resource_detect_count", 1000)?;

        Ok(MetricsSummary {
            conflict_rate,
            avg_work_duration_secs: avg_work_duration,
            degradation_count,
            llm_fault_count,
            treesitter_intercept_count: ts_intercept_count,
            dependency_adapt_count: dep_adapt_count,
            notification_ack_timeout_count: ack_timeout_count,
            duplicate_resource_detect_count: dup_resource_count,
        })
    }
}

/// Metrics summary for a session.
#[derive(Clone, Debug)]
pub struct MetricsSummary {
    pub conflict_rate: f64,
    pub avg_work_duration_secs: f64,
    pub degradation_count: usize,
    pub llm_fault_count: usize,
    pub treesitter_intercept_count: usize,
    pub dependency_adapt_count: usize,
    pub notification_ack_timeout_count: usize,
    pub duplicate_resource_detect_count: usize,
}
