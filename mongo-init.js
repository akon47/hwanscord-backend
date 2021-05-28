db.createUser(
    {
        user: "hwans",
        pwd: "hwans",
        roles: [
            {
                role: "readWrite",
                db: "hwanscord"
            }
        ]
    }
);

db.createCollection("hwanscord");