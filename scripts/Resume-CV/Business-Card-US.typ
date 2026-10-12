#import "@preview/minimalbc:0.0.1":minimalbc
#let person = json("data.json")

#show: minimalbc.with(
    // possible geo_size options: eu, us, jp , cn
    geo_size: "us",
    flip:false,
    company_name: person.company,
    name: person.name,
    role: person.title,
    telephone_number: person.contact.phone,
    email_address: person.contact.email,
    website: person.contact.website,
    company_logo: image("./company_logo.png"),
    bg_color: "ffffff",
)

