//! P3/P6 收口回归测试:验证 memory↔KG 桥接**真实非空**。
//!
//! 这是文档 §11.1 的核心验收点。此前实现把 `session_id` 当作 `memory_id`
//! 传给 `link_entity`,而读取端 `get_memory_links_by_layer` 执行
//! `JOIN memories m ON el.memory_id = m.id` —— session_id 不存在于 memories 表,
//! JOIN 永远匹配不到,桥接结果恒空。本测试用真实 SQLite 锁定该不变式。

use std::sync::Arc;

use context_builder::StructuredAssembler;
use memory_system::MemorySystem;

#[test]
fn kg_bridge_link_is_queryable_after_decision_write() {
    let memory = Arc::new(MemorySystem::new_in_memory().unwrap());
    let assembler = StructuredAssembler::new(memory.clone(), None);

    // 1. 写入一条决策记忆,拿到真实 memory id
    let memory_id = assembler
        .store_decision_to_memory(
            "kg_bridge:node-42",
            "KG bridge linked entity node-42 for session sess-1",
            "",
        )
        .expect("decision should be stored");
    assert!(!memory_id.is_empty());

    // 2. 用真实 memory id 建立链接(与生产路径一致)
    memory
        .link_entity(&memory_id, "node-42", "proj-1", "kg_bridge")
        .unwrap();

    // 3. 读取端必须能查到 —— 这正是 assembler.rs 桥接遍历所用的接口
    let links = memory
        .get_memory_links_by_layer("2", Some("proj-1"))
        .unwrap();
    assert!(
        links.iter().any(|l| l.entity_id == "node-42"),
        "KG bridge must be non-empty; got {links:?}"
    );
}

#[test]
fn linking_with_session_id_yields_empty_bridge_regression_guard() {
    // 反向锁定:用不存在于 memories 表的 id(如 session_id)建链,
    // 读取端因 JOIN 失败必然为空。防止有人改回旧写法。
    let memory = Arc::new(MemorySystem::new_in_memory().unwrap());
    memory
        .link_entity("sess-1", "node-42", "proj-1", "kg_bridge")
        .unwrap();

    let links = memory
        .get_memory_links_by_layer("2", Some("proj-1"))
        .unwrap();
    assert!(
        links.is_empty(),
        "a link whose memory_id is not a real memory row must not surface"
    );
}

#[test]
fn decision_write_is_deduplicated_by_context() {
    let memory = Arc::new(MemorySystem::new_in_memory().unwrap());
    let assembler = StructuredAssembler::new(memory.clone(), None);

    let first = assembler
        .store_decision_to_memory("kg_bridge:node-7", "KG bridge linked entity node-7 for session s", "")
        .expect("first write");
    let second = assembler
        .store_decision_to_memory("kg_bridge:node-7", "KG bridge linked entity node-7 for session s", "")
        .expect("second call must still return an id so the link can be attached");

    assert_eq!(first, second, "dedup must reuse the existing memory id");
}

#[test]
fn short_detail_is_rejected() {
    let memory = Arc::new(MemorySystem::new_in_memory().unwrap());
    let assembler = StructuredAssembler::new(memory, None);
    assert!(assembler.store_decision_to_memory("ctx", "too short", "").is_none());
}

#[test]
fn distinct_contexts_must_not_collapse_into_one_memory() {
    // 关键不变式:`search` 是模糊相关性检索,两个**高度相似但不同**的
    // decision_context 极易互相命中。若不做精确复核,第二条会被静默丢弃,
    // 导致每个 KG 节点只有第一个能建链 —— 桥接依旧近乎恒空。
    let memory = Arc::new(MemorySystem::new_in_memory().unwrap());
    let assembler = StructuredAssembler::new(memory.clone(), None);

    let mut ids = Vec::new();
    for n in 0..5 {
        let id = assembler
            .store_decision_to_memory(
                &format!("kg_bridge:node-{n}"),
                &format!("KG bridge linked entity node-{n} for session sess-1"),
                "",
            )
            .unwrap_or_else(|| panic!("node-{n} must be stored"));
        ids.push(id);
    }
    ids.sort();
    ids.dedup();
    assert_eq!(ids.len(), 5, "5 个不同 context 必须产生 5 条独立记忆, 实得 {ids:?}");
}

#[test]
fn all_kg_nodes_get_a_queryable_link_end_to_end() {
    // 端到端:多节点场景下每个节点都应可被桥接查到。
    let memory = Arc::new(MemorySystem::new_in_memory().unwrap());
    let assembler = StructuredAssembler::new(memory.clone(), None);

    for n in 0..5 {
        let entity = format!("node-{n}");
        if let Some(mid) = assembler.store_decision_to_memory(
            &format!("kg_bridge:{entity}"),
            &format!("KG bridge linked entity {entity} for session sess-1"),
            "",
        ) {
            memory.link_entity(&mid, &entity, "proj-1", "kg_bridge").unwrap();
        }
    }

    let links = memory.get_memory_links_by_layer("2", Some("proj-1")).unwrap();
    for n in 0..5 {
        let entity = format!("node-{n}");
        assert!(
            links.iter().any(|l| l.entity_id == entity),
            "{entity} 未出现在桥接结果中; links={links:?}"
        );
    }
}
