pub struct Configuration {
    pub endpoint: String,
}

pub fn parse_configuration(value: &str) -> Configuration {
    Configuration {
        endpoint: value.to_owned(),
    }
}
