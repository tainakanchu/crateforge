//! Generator (bpmRange / ranges / tags / templates) の展開。

use std::collections::HashMap;

use super::schema::{
    BpmRangeGenerator, BpmRangeTemplate, Condition, FieldCondition, GeneratorEntry,
    GeneratorTemplate, InlineGenerator, PlaylistRule, RangeEntry, RangesGenerator, RangesTemplate,
    SortRule, TagsGenerator, TagsTemplate, TemplateRefGenerator,
};

pub fn expand_generators(
    generators: &[GeneratorEntry],
    templates: &HashMap<String, GeneratorTemplate>,
) -> Result<Vec<PlaylistRule>, String> {
    let mut out = Vec::new();
    for entry in generators {
        match entry {
            GeneratorEntry::Inline(g) => out.extend(expand_inline(g)),
            GeneratorEntry::TemplateRef(t) => {
                let resolved = resolve_template_ref(t, templates)?;
                out.extend(expand_inline(&resolved));
            }
        }
    }
    Ok(out)
}

fn expand_inline(g: &InlineGenerator) -> Vec<PlaylistRule> {
    match g {
        InlineGenerator::BpmRange(g) => expand_bpm_range(g),
        InlineGenerator::Ranges(g) => expand_ranges(g),
        InlineGenerator::Tags(g) => expand_tags(g),
    }
}

fn pad_num(value: i64, width: usize) -> String {
    if width == 0 {
        value.to_string()
    } else {
        format!("{:0>width$}", value, width = width)
    }
}

fn pad_num_f(value: f64, width: usize) -> String {
    // Show as integer when possible (BPM bounds are typically whole numbers).
    if value.fract() == 0.0 {
        pad_num(value as i64, width)
    } else if width == 0 {
        value.to_string()
    } else {
        format!("{:0>width$}", value, width = width)
    }
}

fn expand_bpm_range(g: &BpmRangeGenerator) -> Vec<PlaylistRule> {
    let mut rules = Vec::new();
    let mut lower = g.from;
    while lower < g.to {
        let upper = (lower + g.step).min(g.to);
        let lower_str = pad_num(lower, g.pad);
        let upper_str = pad_num(upper - 1, g.pad);
        let name = format!("{}/{}-{}", g.base_path, lower_str, upper_str);

        let conditions = vec![
            Condition::InPlaylist {
                in_playlist: g.source_playlist.clone(),
            },
            Condition::Field(FieldCondition {
                field: "bpm".to_string(),
                gte: Some(lower as f64),
                ..empty_field()
            }),
            Condition::Field(FieldCondition {
                field: "bpm".to_string(),
                lt: Some(upper as f64),
                ..empty_field()
            }),
        ];

        rules.push(PlaylistRule {
            name,
            description: None,
            match_: Condition::All { all: conditions },
            sort: g.sort.clone(),
            mode: None,
        });

        lower += g.step;
    }
    rules
}

fn build_range_name(range: &RangeEntry, pad: usize) -> String {
    if let Some(name) = &range.name {
        return name.clone();
    }

    let lower = range.gte.or(range.gt);
    let upper = range.lt.or(range.lte);

    match (lower, upper) {
        (Some(l), Some(_)) => {
            let display_upper = match (range.lt, range.lte) {
                (Some(v), _) => v - 1.0,
                (None, Some(v)) => v,
                _ => 0.0,
            };
            format!("{}-{}", pad_num_f(l, pad), pad_num_f(display_upper, pad))
        }
        (Some(l), None) => format!("{}+", pad_num_f(l, pad)),
        (None, Some(_)) => {
            let display_upper = match (range.lt, range.lte) {
                (Some(v), _) => v - 1.0,
                (None, Some(v)) => v,
                _ => 0.0,
            };
            format!("-{}", pad_num_f(display_upper, pad))
        }
        (None, None) => "unknown".to_string(),
    }
}

fn expand_ranges(g: &RangesGenerator) -> Vec<PlaylistRule> {
    let mut rules = Vec::new();
    for range in &g.ranges {
        let name = format!("{}/{}", g.base_path, build_range_name(range, g.pad));
        let mut conditions = vec![Condition::InPlaylist {
            in_playlist: g.source_playlist.clone(),
        }];
        if let Some(v) = range.gte {
            conditions.push(Condition::Field(FieldCondition {
                field: g.field.clone(),
                gte: Some(v),
                ..empty_field()
            }));
        }
        if let Some(v) = range.gt {
            conditions.push(Condition::Field(FieldCondition {
                field: g.field.clone(),
                gt: Some(v),
                ..empty_field()
            }));
        }
        if let Some(v) = range.lt {
            conditions.push(Condition::Field(FieldCondition {
                field: g.field.clone(),
                lt: Some(v),
                ..empty_field()
            }));
        }
        if let Some(v) = range.lte {
            conditions.push(Condition::Field(FieldCondition {
                field: g.field.clone(),
                lte: Some(v),
                ..empty_field()
            }));
        }

        rules.push(PlaylistRule {
            name,
            description: None,
            match_: Condition::All { all: conditions },
            sort: g.sort.clone(),
            mode: None,
        });
    }
    rules
}

fn expand_tags(g: &TagsGenerator) -> Vec<PlaylistRule> {
    let mut rules = Vec::new();
    for value in &g.values {
        let name = format!("{}/{}", g.base_path, value);
        let conditions = vec![
            Condition::InPlaylist {
                in_playlist: g.source_playlist.clone(),
            },
            Condition::Field(FieldCondition {
                field: g.field.clone(),
                contains: Some(value.clone()),
                ..empty_field()
            }),
        ];
        rules.push(PlaylistRule {
            name,
            description: None,
            match_: Condition::All { all: conditions },
            sort: g.sort.clone(),
            mode: None,
        });
    }
    rules
}

fn resolve_template_ref(
    entry: &TemplateRefGenerator,
    templates: &HashMap<String, GeneratorTemplate>,
) -> Result<InlineGenerator, String> {
    let tmpl = templates.get(&entry.template).ok_or_else(|| {
        format!(
            "Generator references unknown template \"{}\"",
            entry.template
        )
    })?;

    let sort: Option<Vec<SortRule>> = entry.sort.clone().or_else(|| match tmpl {
        GeneratorTemplate::BpmRange(t) => t.sort.clone(),
        GeneratorTemplate::Ranges(t) => t.sort.clone(),
        GeneratorTemplate::Tags(t) => t.sort.clone(),
    });

    Ok(match tmpl {
        GeneratorTemplate::BpmRange(BpmRangeTemplate {
            from,
            to,
            step,
            pad,
            ..
        }) => InlineGenerator::BpmRange(BpmRangeGenerator {
            base_path: entry.base_path.clone(),
            source_playlist: entry.source_playlist.clone(),
            from: *from,
            to: *to,
            step: *step,
            pad: *pad,
            sort,
        }),
        GeneratorTemplate::Ranges(RangesTemplate {
            field, ranges, pad, ..
        }) => InlineGenerator::Ranges(RangesGenerator {
            base_path: entry.base_path.clone(),
            source_playlist: entry.source_playlist.clone(),
            field: field.clone(),
            ranges: ranges.clone(),
            pad: *pad,
            sort,
        }),
        GeneratorTemplate::Tags(TagsTemplate { field, values, .. }) => {
            InlineGenerator::Tags(TagsGenerator {
                base_path: entry.base_path.clone(),
                source_playlist: entry.source_playlist.clone(),
                field: field.clone(),
                values: values.clone(),
                sort,
            })
        }
    })
}

fn empty_field() -> FieldCondition {
    FieldCondition {
        field: String::new(),
        equals: None,
        contains: None,
        in_: None,
        gt: None,
        gte: None,
        lt: None,
        lte: None,
        exists: None,
    }
}
